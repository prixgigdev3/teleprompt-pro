import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal fake of Chrome's SpeechRecognition to drive SpeechEngine.
class FakeRecognition {
  static instances = [];
  constructor() {
    FakeRecognition.instances.push(this);
    this.started = false;
    this.aborted = false;
  }
  start() {
    if (this.started) throw new DOMException('already started', 'InvalidStateError');
    this.started = true;
    queueMicrotask(() => this.onstart && this.onstart());
  }
  abort() { this.aborted = true; }
  stop() { this.aborted = true; }
  emitResult(transcripts) {
    this.onresult && this.onresult({
      results: transcripts.map((t) => [{ transcript: t }]),
      resultIndex: 0,
    });
  }
  emitError(error) { this.onerror && this.onerror({ error }); }
  emitEnd() { this.onend && this.onend(); }
}

globalThis.window = { SpeechRecognition: FakeRecognition };
const { SpeechEngine } = await import('../js/speech.js');

function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

test('start spins up a recognizer and forwards words', async () => {
  FakeRecognition.instances = [];
  const heard = [];
  const engine = new SpeechEngine({ onWords: (w) => heard.push(w) });
  engine.start();
  await tick();
  assert.equal(FakeRecognition.instances.length, 1);
  FakeRecognition.instances[0].emitResult(['hello there', 'general kenobi']);
  assert.deepEqual(heard, [['hello', 'there', 'general', 'kenobi']]);
  engine.stop();
});

test('session end auto-restarts while active', async () => {
  FakeRecognition.instances = [];
  const engine = new SpeechEngine({});
  engine.start();
  await tick();
  FakeRecognition.instances[0].emitEnd();
  await tick(250);
  assert.equal(FakeRecognition.instances.length, 2, 'should have spun a second recognizer');
  assert.ok(FakeRecognition.instances[1].started);
  engine.stop();
});

test('stop prevents restart and detaches the old instance', async () => {
  FakeRecognition.instances = [];
  const heard = [];
  const engine = new SpeechEngine({ onWords: (w) => heard.push(w) });
  engine.start();
  await tick();
  const rec = FakeRecognition.instances[0];
  engine.stop();
  assert.ok(rec.aborted);
  // Late events from a detached instance must not leak through.
  assert.equal(rec.onresult, null);
  rec.emitEnd();
  await tick(300);
  assert.equal(FakeRecognition.instances.length, 1, 'no restart after stop');
  assert.equal(heard.length, 0);
});

test('mic denial deactivates the engine and reports the error', async () => {
  FakeRecognition.instances = [];
  const errors = [];
  const states = [];
  const engine = new SpeechEngine({ onError: (e) => errors.push(e), onState: (s) => states.push(s) });
  engine.start();
  await tick();
  FakeRecognition.instances[0].emitError('not-allowed');
  FakeRecognition.instances[0].emitEnd(); // Chrome fires onend after onerror
  await tick(300);
  assert.deepEqual(errors, ['mic-denied']);
  assert.equal(engine.active, false);
  assert.equal(FakeRecognition.instances.length, 1, 'no restart after fatal error');
});

test('rapid death backs off and eventually reports unstable', async () => {
  FakeRecognition.instances = [];
  const errors = [];
  const engine = new SpeechEngine({ onError: (e) => errors.push(e) });
  engine.start();
  await tick();
  // Sessions that die instantly 12 times → 'unstable' warning, still retrying.
  for (let i = 0; i < 12; i++) {
    FakeRecognition.instances[FakeRecognition.instances.length - 1].emitEnd();
    await tick(2100);
  }
  assert.ok(errors.includes('unstable'));
  assert.ok(engine.active, 'engine keeps trying');
  engine.stop();
});

test('start while already active is a no-op', async () => {
  FakeRecognition.instances = [];
  const engine = new SpeechEngine({});
  engine.start();
  engine.start();
  await tick();
  assert.equal(FakeRecognition.instances.length, 1);
  engine.stop();
});

test('flush drops the session and spins a fresh recognizer', async () => {
  FakeRecognition.instances = [];
  const engine = new SpeechEngine({});
  engine.start();
  await tick();
  const rec = FakeRecognition.instances[0];
  engine.flush();
  await tick();
  assert.ok(rec.aborted, 'old session aborted');
  assert.equal(rec.onresult, null, 'old session detached');
  assert.equal(FakeRecognition.instances.length, 2);
  assert.ok(FakeRecognition.instances[1].started);
  engine.stop();
});

test('flush while inactive is a no-op', () => {
  FakeRecognition.instances = [];
  const engine = new SpeechEngine({});
  engine.flush();
  assert.equal(FakeRecognition.instances.length, 0);
});

test('long-lived sessions reset the instability counter', async () => {
  FakeRecognition.instances = [];
  const errors = [];
  const engine = new SpeechEngine({ onError: (e) => errors.push(e) });
  engine.start();
  await tick();
  // A few quick deaths build the counter...
  for (let i = 0; i < 4; i++) {
    FakeRecognition.instances[FakeRecognition.instances.length - 1].emitEnd();
    await tick(2100);
  }
  assert.ok(engine._recentRestarts >= 4);
  // ...then one healthy long session (e.g. ended by silence) clears it.
  engine._sessionStartedAt = Date.now() - 8000;
  FakeRecognition.instances[FakeRecognition.instances.length - 1].emitEnd();
  await tick(2100);
  assert.equal(engine._recentRestarts, 0);
  assert.ok(!errors.includes('unstable'));
  engine.stop();
});
