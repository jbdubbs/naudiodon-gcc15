// Verifies how an input status flag (e.g. "input overflow") is handled for
// closeOnError true vs false.
//
// An overflow is provoked by blocking the Node event loop: the PortAudio
// callback thread pushes into a bounded chunk queue (maxQueue) that only
// drains when JS reads, so a long enough stall blocks the callback thread and
// PortAudio reports an input overflow on the next callback.
//
// Usage (needs a real capture device; silence is fine):
//   CLOSE_ON_ERROR=false node scratch/closeOnErrorStall.js   # expect: survives, pa-status emitted
//   CLOSE_ON_ERROR=true  node scratch/closeOnErrorStall.js   # expect: stream destroyed with the status
// Optional env: DEVICE (exact device name, default "pipewire"), MAX_QUEUE
// (default 2, small so the stall overflows quickly), STALL_MS (default 1000),
// FRAMES (framesPerBuffer, default 0), AFTER_MS (observation window after the
// stall, default 4000), CHANNELS (default 1; raw hw: devices are often stereo-only).
//
// Do NOT point DEVICE at a device a live application is using.

const portAudio = require('../index.js');

const closeOnError = process.env.CLOSE_ON_ERROR !== 'false';
const deviceName = process.env.DEVICE || 'pipewire';
const maxQueue = parseInt(process.env.MAX_QUEUE || '2', 10);
const stallMs = parseInt(process.env.STALL_MS || '1000', 10);
const frames = parseInt(process.env.FRAMES || '0', 10);
const afterMs = parseInt(process.env.AFTER_MS || '4000', 10);
const channels = parseInt(process.env.CHANNELS || '1', 10);

const device = portAudio.getDevices().find(d => d.name === deviceName && d.maxInputChannels > 0);
if (!device) {
  console.error(`No input device named ${JSON.stringify(deviceName)}`);
  process.exit(2);
}

const ai = new portAudio.AudioIO({
  inOptions: {
    channelCount: channels,
    sampleFormat: portAudio.SampleFormat16Bit,
    sampleRate: 48000,
    deviceId: device.id,
    closeOnError,
    framesPerBuffer: frames,
    maxQueue,
    highwaterMark: 256
  }
});

let dataEvents = 0;
let statuses = [];
let closed = false;
let errorValue = null;
ai.on('data', () => { dataEvents++; });
ai.on('pa-status', s => statuses.push(String(s).trim()));
ai.on('error', e => { errorValue = String(e); });
ai.on('close', () => { closed = true; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const blockEventLoop = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

(async () => {
  ai.start();
  await sleep(1500);
  const before = dataEvents;
  if (before === 0) {
    console.error('FAIL: no data received before the stall (device not producing callbacks)');
    process.exit(1);
  }
  console.log(`closeOnError=${closeOnError} device=${JSON.stringify(deviceName)} maxQueue=${maxQueue} frames=${frames}`);
  console.log(`data events before stall: ${before}; blocking event loop for ${stallMs} ms`);
  blockEventLoop(stallMs);
  const perSecond = [];
  for (let waited = 0; waited < afterMs; waited += 1000) {
    const mark = dataEvents;
    await sleep(1000);
    perSecond.push(dataEvents - mark);
  }
  const after = dataEvents;
  console.log(`data events per second after stall: ${JSON.stringify(perSecond)}`);

  console.log(`data events after stall: ${after - before}`);
  console.log(`pa-status events: ${JSON.stringify(statuses)}`);
  console.log(`closed: ${closed}; error: ${errorValue}`);

  let ok;
  if (closeOnError) {
    // Legacy behaviour must be intact: the status destroys the stream (only if
    // the stall actually produced one).
    ok = closed && errorValue !== null && errorValue.includes('portAudio status');
    if (!ok && statuses.length === 0 && !closed) console.error('INCONCLUSIVE: the stall did not provoke a status flag; raise STALL_MS or lower MAX_QUEUE');
  } else {
    ok = !closed && statuses.length > 0 && (after - before) > 0 && errorValue === null;
    if (!ok && statuses.length === 0 && !closed) console.error('INCONCLUSIVE: the stall did not provoke a status flag; raise STALL_MS or lower MAX_QUEUE');
  }
  console.log(ok ? 'PASS' : 'FAIL');
  try { await ai.quit(); } catch (e) {}
  setTimeout(() => process.exit(ok ? 0 : 1), 100);
})();
