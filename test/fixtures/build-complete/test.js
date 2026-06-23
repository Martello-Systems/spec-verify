import { createWidget } from './server.js';

const w = createWidget('foo');
if (w.name !== 'foo' || w.kind !== 'widget') {
  console.error('widget test failed');
  process.exit(1);
}
console.log('widget test passed');
