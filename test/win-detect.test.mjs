import test from 'node:test';
import assert from 'node:assert/strict';
import { findBin, windowsBinCandidates, registryPathDirs } from '../chat/env.js';
import { defaultFind } from '../setup.js';

const env = {
  PATH: 'C:\\old;C:\\Windows\\System32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
};

test('Windows: a program installed after this process started is found through the registry PATH', () => {
  const installed = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
  const found = findBin('cloudflared', { platform: 'win32', isFile: (f) => f.toLowerCase() === installed.toLowerCase(), candidates: windowsBinCandidates('cloudflared', { env, registryDirs: ['C:\\Program Files (x86)\\cloudflared'] }) });
  assert.equal(found, installed);
});

test('Windows: the default install folder is tried even when no PATH has it', () => {
  const found = findBin('cloudflared', { platform: 'win32', isFile: (f) => f === 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', candidates: windowsBinCandidates('cloudflared', { env, registryDirs: [] }) });
  assert.equal(found, 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
});

test('Windows: PATH is split on ";", extensions come from PATHEXT, and an app alias is a candidate', () => {
  const list = windowsBinCandidates('winget', { env, registryDirs: [] });
  assert.ok(list.includes('C:\\old\\winget.exe') && list.includes('C:\\Windows\\System32\\winget.cmd'), 'both PATH entries and both extensions');
  assert.ok(list.includes('C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe'), 'the winget app alias folder');
  assert.equal(new Set(list.map((f) => f.toLowerCase())).size, list.length, 'no duplicates');
});

test('Windows: nothing found is null, not a throw', () => {
  assert.equal(findBin('nope', { platform: 'win32', isFile: () => false, candidates: windowsBinCandidates('nope', { env, registryDirs: [] }) }), null);
});

test('registryPathDirs reads reg query output and expands variables', () => {
  const run = (cmd, args) => {
    assert.equal(cmd, 'reg');
    return args[1].startsWith('HKLM')
      ? '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\...\\Environment\r\n    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files (x86)\\cloudflared\\\r\n\r\n'
      : 'HKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    C:\\Users\\u\\bin\r\n';
  };
  assert.deepEqual(registryPathDirs({ SystemRoot: 'C:\\Windows' }, run), ['C:\\Windows\\system32', 'C:\\Program Files (x86)\\cloudflared\\', 'C:\\Users\\u\\bin']);
  assert.deepEqual(registryPathDirs({}, () => { throw new Error('no reg'); }), [], 'a failing reg call is not fatal');
});

test('setup finds winget and cloudflared on Windows through the same lookup', () => {
  const alias = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe';
  assert.equal(defaultFind({ id: 'winget', bin: 'winget' }, { platform: 'win32', env, exists: (f) => f === alias }), alias);
});
