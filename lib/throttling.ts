/**
 * Network + CPU profiles applied through a CDP session attached to the page.
 */
import type { CDPSession } from '@playwright/test';

export type ProfileName = 'desktop' | 'mobile-slow4g';

export interface Profile {
  name: ProfileName;
  label: string;
  viewport: { width: number; height: number };
  mobile: boolean;
  /** null = no network throttling */
  network: { latencyMs: number; downloadKbps: number; uploadKbps: number } | null;
  cpuRate: number;
}

export const PROFILES: Record<ProfileName, Profile> = {
  desktop: {
    name: 'desktop',
    label: 'Desktop, no throttling, 1366×768',
    viewport: { width: 1366, height: 768 },
    mobile: false,
    network: null,
    cpuRate: 1,
  },
  'mobile-slow4g': {
    name: 'mobile-slow4g',
    label: 'Mobile, slow 4G (150 ms latency, 1.6 Mbps down, 750 Kbps up) + 4× CPU slowdown, 390×844',
    viewport: { width: 390, height: 844 },
    mobile: true,
    network: { latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 },
    cpuRate: 4,
  },
};

export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{v}.0.0.0 Mobile Safari/537.36';
export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{v}.0.0.0 Safari/537.36';

export function profileByName(name: string): Profile {
  const p = (PROFILES as Record<string, Profile>)[name];
  if (!p) throw new Error(`Unknown profile "${name}" (expected one of ${Object.keys(PROFILES).join(', ')})`);
  return p;
}

const kbpsToBytesPerSec = (kbps: number) => Math.round((kbps * 1000) / 8);

/** Apply a profile to the page behind this CDP session. Safe to call again after cache toggles. */
export async function applyProfile(cdp: CDPSession, profile: Profile): Promise<void> {
  await cdp.send('Network.enable');
  if (profile.network) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: profile.network.latencyMs,
      downloadThroughput: kbpsToBytesPerSec(profile.network.downloadKbps),
      uploadThroughput: kbpsToBytesPerSec(profile.network.uploadKbps),
      connectionType: 'cellular4g',
    });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
}

/** Remove throttling (used around harness-only work such as axe scans). */
export async function clearThrottling(cdp: CDPSession): Promise<void> {
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}

export async function setCacheDisabled(cdp: CDPSession, disabled: boolean): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: disabled });
}
