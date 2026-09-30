// allowlist.mjs: what the xdotool helper accepts from Steam's UI JS.
// usage: node allowlist.test.mjs <allowlist.mjs>
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { allowedCombo, allowedChar } = await import(pathToFileURL(process.argv[2]).href);
const accept = ['shift+Tab', 'ctrl+Tab', 'ctrl+shift+Tab', 'ctrl+shift+t', 'alt+f',
  'shift+Left', 'Escape', 'Delete', 'shift+End', 'ctrl+BackSpace'];
const reject = ['Tab', 'shift+a', 'a', 'Return', 'shift+Return', 'ctrl+Return', 'shift+BackSpace',
  'shift+shift+Tab', 'super+Tab', 'shift+space', 'ctrl+a+b'];
const acceptChar = ['ä', '€', '|', '@', '\\', '`'];
const rejectChar = ['a', 'A', '1', ' ', '\n', '\t', 'ab', ' '];
for (const c of accept) assert.equal(allowedCombo(c), true, `accepts key:${c}`);
for (const c of reject) assert.equal(allowedCombo(c), false, `rejects key:${c}`);
for (const c of acceptChar) assert.equal(allowedChar(c), true, `accepts type:${c}`);
for (const c of rejectChar) assert.equal(allowedChar(c), false, `rejects type:${JSON.stringify(c)}`);
console.log(`allowlist: ${accept.length + reject.length + acceptChar.length + rejectChar.length} cases passed`);
