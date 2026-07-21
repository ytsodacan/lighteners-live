// Minimal Standard MIDI File (SMF) parser — reads note on/off + tempo events.
// Returns { events: [{tick, absTime, type, note, velocity, track}], ticksPerBeat }
// where absTime is in seconds, correctly following any tempo changes.

function parseMidi(arrayBuffer) {
  const data = new DataView(arrayBuffer);
  let pos = 0;

  function readUint32() { const v = data.getUint32(pos); pos += 4; return v; }
  function readUint16() { const v = data.getUint16(pos); pos += 2; return v; }
  function readUint8() { const v = data.getUint8(pos); pos += 1; return v; }
  function readString(len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(readUint8());
    return s;
  }
  function readVarLen() {
    let value = 0;
    let byte;
    do {
      byte = readUint8();
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return value;
  }

  const headerId = readString(4);
  if (headerId !== 'MThd') throw new Error('Not a valid MIDI file (missing MThd)');
  const headerLen = readUint32();
  const format = readUint16();
  const numTracks = readUint16();
  const division = readUint16();

  if (division & 0x8000) {
    throw new Error('SMPTE time division MIDI files are not supported — please export using ticks-per-beat (PPQ).');
  }
  const ticksPerBeat = division;

  // Collect raw events per track with absolute tick times (per-track delta accumulation).
  const allTrackEvents = [];
  const tempoEvents = []; // {tick, usPerBeat} collected across all tracks

  for (let t = 0; t < numTracks; t++) {
    const chunkId = readString(4);
    const chunkLen = readUint32();
    const chunkEnd = pos + chunkLen;
    if (chunkId !== 'MTrk') { pos = chunkEnd; continue; }

    let tick = 0;
    let runningStatus = null;
    const trackEvents = [];

    while (pos < chunkEnd) {
      const delta = readVarLen();
      tick += delta;

      let statusByte = readUint8();
      if (statusByte < 0x80) {
        // running status: reuse previous status, back up one byte
        pos -= 1;
        statusByte = runningStatus;
      } else {
        runningStatus = statusByte;
      }

      const eventType = statusByte & 0xf0;
      const channel = statusByte & 0x0f;

      if (statusByte === 0xff) {
        // Meta event
        const metaType = readUint8();
        const len = readVarLen();
        const metaStart = pos;
        if (metaType === 0x51 && len === 3) {
          // Set Tempo
          const usPerBeat = (readUint8() << 16) | (readUint8() << 8) | readUint8();
          tempoEvents.push({ tick, usPerBeat });
        } else {
          pos = metaStart + len;
        }
        pos = metaStart + len;
      } else if (statusByte === 0xf0 || statusByte === 0xf7) {
        // Sysex event
        const len = readVarLen();
        pos += len;
      } else if (eventType === 0x80 || eventType === 0x90 || eventType === 0xa0 || eventType === 0xb0 || eventType === 0xe0) {
        // note off, note on, poly aftertouch, control change, pitch bend — all 2 data bytes
        const d1 = readUint8();
        const d2 = readUint8();
        if (eventType === 0x90) {
          trackEvents.push({ tick, type: d2 === 0 ? 'note_off' : 'note_on', note: d1, velocity: d2, channel });
        } else if (eventType === 0x80) {
          trackEvents.push({ tick, type: 'note_off', note: d1, velocity: d2, channel });
        }
      } else if (eventType === 0xc0 || eventType === 0xd0) {
        // program change, channel aftertouch — 1 data byte
        readUint8();
      } else {
        // Unknown status byte; bail out of this track to avoid corrupting the read position.
        pos = chunkEnd;
        break;
      }
    }
    pos = chunkEnd;
    allTrackEvents.push(trackEvents);
  }

  // Build global tempo map sorted by tick, default 120bpm (500000 us/beat) if none present before tick 0
  tempoEvents.sort((a, b) => a.tick - b.tick);
  if (tempoEvents.length === 0 || tempoEvents[0].tick > 0) {
    tempoEvents.unshift({ tick: 0, usPerBeat: 500000 });
  }

  // Precompute cumulative seconds at each tempo-change tick
  const tempoMap = [];
  let accSeconds = 0;
  let prevTick = 0;
  let prevUsPerBeat = tempoEvents[0].usPerBeat;
  for (let i = 0; i < tempoEvents.length; i++) {
    const te = tempoEvents[i];
    if (i > 0) {
      const deltaTicks = te.tick - prevTick;
      accSeconds += (deltaTicks / ticksPerBeat) * (prevUsPerBeat / 1000000);
    }
    tempoMap.push({ tick: te.tick, accSeconds, usPerBeat: te.usPerBeat });
    prevTick = te.tick;
    prevUsPerBeat = te.usPerBeat;
  }

  function tickToSeconds(tick) {
    // find last tempoMap entry with tick <= given tick
    let lo = 0, hi = tempoMap.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tempoMap[mid].tick <= tick) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const entry = tempoMap[idx];
    const deltaTicks = tick - entry.tick;
    return entry.accSeconds + (deltaTicks / ticksPerBeat) * (entry.usPerBeat / 1000000);
  }

  // Merge all track events into one flat, time-sorted list
  const merged = [];
  for (let t = 0; t < allTrackEvents.length; t++) {
    for (const ev of allTrackEvents[t]) {
      merged.push({ ...ev, track: t, time: tickToSeconds(ev.tick) });
    }
  }
  merged.sort((a, b) => a.time - b.time);

  return { events: merged, ticksPerBeat, format, numTracks };
}

// Build a rhythm-game chart from parsed MIDI note events, following the same
// note-number convention as the original Godot project:
//   38 = left tap, 36 = right tap, 39 = left hold, 35 = right hold
function buildChartFromMidi(parsed, opts) {
  const LEFT_TAP = 38, RIGHT_TAP = 36, LEFT_HOLD = 39, RIGHT_HOLD = 35;
  const HOLD_SPAWN_INTERVAL = opts.holdSpawnInterval ?? 0.08;

  const taps = []; // {time, lane}
  const holdSpans = []; // {lane, start, end}
  const activeHoldStart = {};

  for (const ev of parsed.events) {
    if (ev.type === 'note_on') {
      if (ev.note === LEFT_TAP) taps.push({ time: ev.time, lane: 'left' });
      else if (ev.note === RIGHT_TAP) taps.push({ time: ev.time, lane: 'right' });
      else if (ev.note === LEFT_HOLD) activeHoldStart['left'] = ev.time;
      else if (ev.note === RIGHT_HOLD) activeHoldStart['right'] = ev.time;
    } else if (ev.type === 'note_off') {
      if (ev.note === LEFT_HOLD && activeHoldStart['left'] != null) {
        holdSpans.push({ lane: 'left', start: activeHoldStart['left'], end: ev.time });
        delete activeHoldStart['left'];
      } else if (ev.note === RIGHT_HOLD && activeHoldStart['right'] != null) {
        holdSpans.push({ lane: 'right', start: activeHoldStart['right'], end: ev.time });
        delete activeHoldStart['right'];
      }
    }
  }

  // Many MIDI exports re-trigger a "held" note every beat/bar instead of
  // using one long note-on/note-off — that shows up here as a chain of
  // separate hold spans with a tiny gap between them. Merge those into one
  // continuous span per lane so they render (and play) as a single connected
  // hold instead of a row of visually-separated bars.
  const MERGE_GAP = 0.15; // seconds
  function mergeSpans(spans) {
    spans.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.start - last.end <= MERGE_GAP) last.end = Math.max(last.end, s.end);
      else merged.push({ lane: s.lane, start: s.start, end: s.end });
    }
    return merged;
  }
  const mergedHoldSpans = [
    ...mergeSpans(holdSpans.filter(s => s.lane === 'left')),
    ...mergeSpans(holdSpans.filter(s => s.lane === 'right')),
  ];

  // Expand hold spans into discrete pieces spawned every HOLD_SPAWN_INTERVAL, matching original spawn behavior
  const holdPieces = [];
  let holdId = 1;
  for (const span of mergedHoldSpans) {
    const id = holdId++;
    let t = span.start;
    while (t < span.end) {
      holdPieces.push({ time: t, lane: span.lane, holdId: id, holdStart: span.start, holdEnd: span.end });
      t += HOLD_SPAWN_INTERVAL;
    }
  }

  taps.sort((a, b) => a.time - b.time);
  holdPieces.sort((a, b) => a.time - b.time);

  const duration = Math.max(
    0,
    ...parsed.events.map(e => e.time),
    ...taps.map(t => t.time),
    ...holdPieces.map(h => h.time)
  );

  return { taps, holdPieces, duration };
}
