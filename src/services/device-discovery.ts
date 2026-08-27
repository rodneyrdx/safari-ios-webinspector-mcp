import { execFileText, commandPath } from "../utils/exec.js";

export interface PhysicalDeviceRecord {
  udid: string;
  displayName: string;
  iosVersion?: string;
}

export async function listTrustedDevices(): Promise<PhysicalDeviceRecord[]> {
  const ideviceId = await commandPath("idevice_id");
  const ideviceInfo = await commandPath("ideviceinfo");
  if (!ideviceId || !ideviceInfo) {
    return [];
  }

  const { stdout } = await execFileText(ideviceId, ["-l"], 3000);
  const udids = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const devices = await Promise.all(udids.map((udid) => inspectDevice(ideviceInfo, udid)));
  return devices.filter((device): device is PhysicalDeviceRecord => Boolean(device));
}

export function matchTrustedDevice(
  displayName: string,
  trustedDevices: PhysicalDeviceRecord[]
): PhysicalDeviceRecord | undefined {
  const normalizedName = displayName.trim().toLowerCase();
  const exact = trustedDevices.find((device) => device.displayName.trim().toLowerCase() === normalizedName);
  if (exact) {
    return exact;
  }
  if (trustedDevices.length === 1) {
    return trustedDevices[0];
  }
  return undefined;
}

async function inspectDevice(
  ideviceInfoPath: string,
  udid: string
): Promise<PhysicalDeviceRecord | undefined> {
  try {
    const [displayName, iosVersion] = await Promise.all([
      readInfoValue(ideviceInfoPath, udid, "DeviceName"),
      readInfoValue(ideviceInfoPath, udid, "ProductVersion")
    ]);

    if (!displayName) {
      return undefined;
    }

    return {
      udid,
      displayName,
      iosVersion: iosVersion || undefined
    };
  } catch {
    return undefined;
  }
}

async function readInfoValue(
  ideviceInfoPath: string,
  udid: string,
  key: string
): Promise<string> {
  const { stdout } = await execFileText(ideviceInfoPath, ["-u", udid, "-k", key], 3000);
  return stdout.trim();
}
