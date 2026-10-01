import { expect, test } from 'bun:test';
import { installPlatform } from './install.ts';

const ua = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/19.0 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
};

test('Windows gets the PowerShell installer; everything else the shell script', () => {
  expect(installPlatform(new Headers({ 'user-agent': ua.windows }))).toBe('windows');
  expect(installPlatform(new Headers({ 'user-agent': ua.mac }))).toBe('unix');
  expect(installPlatform(new Headers({ 'user-agent': ua.linux }))).toBe('unix');
  expect(installPlatform(new Headers())).toBe('unix');
});

test('the client hint wins over the User-Agent', () => {
  const headers = new Headers({ 'user-agent': ua.mac, 'sec-ch-ua-platform': '"Windows"' });
  expect(installPlatform(headers)).toBe('windows');
});
