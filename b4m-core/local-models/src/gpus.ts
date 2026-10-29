import { access, readdir, readFile, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

const GIB = 1024 ** 3;
/** The cut-off Ollama's former amdgpu discovery used: an APU's default carve-out reports 1 GiB or less. */
const INTEGRATED_MAX_VRAM_BYTES = GIB;
/** The first Maxwell device id; older NVIDIA parts are below every Ollama CUDA build's compute capability. */
const NVIDIA_FIRST_MAXWELL_DEVICE = 0x1340;
/** Win32_VideoController.AdapterRAM is a uint32 that drivers clamp here for cards with 4 GiB or more. */
const ADAPTER_RAM_CAP = 0xfff00000;
// gfx targets as KFD encodes them (gfxXYZ = X*10000 + Y*100 + Z), from the APU and dGPU cases in amdkfd's
// kfd_device.c. A target in neither list (a newer part, or gfx942 shared by MI300A and MI300X) stays unmeasured.
const STRIX_HALO_GFX_TARGET = 110501;
// Every Strix Halo SKU shares one PCI device id (pci.ids, libdrm amdgpu.ids); checked when KFD is not mounted.
const STRIX_HALO_DEVICE_ID = '1586';
const STRIX_HALO_NAME = /\b(?:8040S|8050S|8060S)\b/i;
const TTM_PAGE_BYTES = 4096;
const AMD_APU_GFX_TARGETS = new Set([
  70000, // Kaveri
  80001, // Carrizo
  90002, // Raven, Picasso
  90009, // Raven2 (Dali, Pollock)
  90012, // Renoir, Lucienne, Cezanne, Barcelo
  100103, // Cyan Skillfish
  100303, // Van Gogh
  100305, // Rembrandt
  100306, // Raphael, Granite Ridge
  100307, // Mendocino
  110003, // Phoenix, Hawk Point
  110500, // Strix Point
  110502, // Krackan Point
]);
const AMD_DISCRETE_GFX_TARGETS = new Set([
  70001, // Hawaii
  80002, // Tonga
  80003, // Fiji, RX 400/500, Vega M
  90000, // Vega 10
  90004, // Vega 12
  90006, // Vega 20
  90008, // Arcturus (MI100)
  90010, // Aldebaran (MI200)
  90500, // MI350
  100100, // Navi 10
  100101, // Navi 12
  100102, // Navi 14
  100300, // Navi 21
  100301, // Navi 22
  100302, // Navi 23
  100304, // Navi 24
  110000, // Navi 31
  110001, // Navi 32
  110002, // Navi 33
  120000, // Navi 44
  120001, // Navi 48
]);

const VENDORS: Record<string, GpuVendor | undefined> = { '10de': 'nvidia', '1002': 'amd', '8086': 'intel' };
const VENDOR_LABELS = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' } as const;
const PCI_IDS_FILES = ['usr/share/hwdata/pci.ids', 'usr/share/misc/pci.ids', 'usr/share/pci.ids'];

export type GpuVendor = 'nvidia' | 'amd' | 'intel';

/** A GPU a local runtime can use; unsupported integrated GPUs and cards no runtime drives are left out. */
export interface DetectedGpu {
  vendor: GpuVendor;
  name: string | null;
  /** Dedicated VRAM, or what ROCm can allocate on a shared-memory GPU; null when the OS does not expose it. */
  memoryBytes: number | null;
  /**
   * Strix Halo, which ROCm serves from its firmware carve-out (memory the OS does not see) or from GTT in the RAM the
   * OS sees: GTT on kernels 6.10 to 6.14, and from 6.15 only when GTT is larger than the carve-out.
   */
  sharedMemory?: 'carve-out' | 'gtt';
  /** The kernel version could not be read, so `memoryBytes` is the smaller of the carve-out and the GTT budget. */
  memoryUnconfirmed?: true;
}

interface PciGpu extends DetectedGpu {
  vendorId: string;
  deviceId: string;
}

interface KfdNode {
  gfxTarget: number;
  cpuCores: number;
}

type Environment = Record<string, string | undefined>;

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

function positive(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
}

function pciAddress(domain: number, locationId: number): string {
  const hex = (value: number, width: number) => value.toString(16).padStart(width, '0');
  return `${hex(domain, 4)}:${hex((locationId >> 8) & 0xff, 2)}:${hex((locationId >> 3) & 0x1f, 2)}.${locationId & 7}`;
}

/** KFD topology GPU nodes by PCI address. */
async function kfdNodes(root: string): Promise<Map<string, KfdNode>> {
  const nodesDir = join(root, 'sys/class/kfd/kfd/topology/nodes');
  const nodes = await readdir(nodesDir).catch((): string[] => []);
  const byAddress = new Map<string, KfdNode>();
  await Promise.all(
    nodes.map(async node => {
      const properties = new Map(
        ((await readText(join(nodesDir, node, 'properties'))) ?? '')
          .split('\n')
          .map(line => line.trim().split(/\s+/))
          .map(([key, value]) => [key, Number(value)] as const)
      );
      const location = properties.get('location_id');
      if (!location || !properties.get('simd_count')) return;
      byAddress.set(pciAddress(properties.get('domain') ?? 0, location), {
        gfxTarget: properties.get('gfx_target_version') ?? 0,
        cpuCores: properties.get('cpu_cores_count') ?? 0,
      });
    })
  );
  return byAddress;
}

async function canOpenDevice(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Check device permissions too: a container without the GPU passed in can still see its sysfs. */
async function reachable(root: string, dir: string, driver: string): Promise<boolean> {
  if (driver === 'nvidia') return canOpenDevice(join(root, 'dev/nvidiactl'));
  const entries = await readdir(join(dir, 'drm')).catch((): string[] => []);
  const nodes = entries.filter(entry => entry.startsWith('renderD'));
  const found = await Promise.all(nodes.map(node => canOpenDevice(join(root, 'dev/dri', node))));
  return found.includes(true);
}

type Classified = { gpu: PciGpu; reachable: boolean } | null | undefined;

/**
 * How amdgpu_amdkfd_get_local_mem_info sizes an APU for ROCm, by kernel: the carve-out before 6.10, the TTM page
 * limit on every APU from 6.10, and from 6.15 the TTM page limit only when GTT is larger than the carve-out
 * (apu_prefer_gtt). Null when the kernel version cannot be read.
 */
type KfdApuRule = 'carve-out' | 'ttm' | 'prefer-gtt' | null;

async function kfdApuRule(root: string): Promise<KfdApuRule> {
  const match = /^Linux version (\d+)\.(\d+)/.exec((await readText(join(root, 'proc/version'))) ?? '');
  if (!match) return null;
  const version = Number(match[1]) * 1000 + Number(match[2]);
  if (version < 6010) return 'carve-out';
  return version < 6015 ? 'ttm' : 'prefer-gtt';
}

/**
 * The memory ROCm can allocate on Strix Halo under `rule`. KFD reports the TTM page limit even when amdgpu.gttsize
 * sets GTT lower, but those allocations land in GTT and its manager refuses them past the GTT size (amdgpu_gtt_mgr),
 * so the GTT size caps it. An unknown rule takes the smaller of the carve-out and that budget.
 */
async function strixHaloMemory(
  root: string,
  dir: string,
  vram: number | null,
  rule: KfdApuRule
): Promise<Pick<DetectedGpu, 'memoryBytes' | 'sharedMemory' | 'memoryUnconfirmed'>> {
  const gtt = positive(await readText(join(dir, 'mem_info_gtt_total')));
  if (vram === null || gtt === null) return { memoryBytes: null, sharedMemory: 'carve-out' };
  const pages = positive(await readText(join(root, 'sys/module/ttm/parameters/pages_limit')));
  const carveOut = { memoryBytes: vram, sharedMemory: 'carve-out' } as const;
  const shared = {
    memoryBytes: Math.min(gtt, pages === null ? gtt : pages * TTM_PAGE_BYTES),
    sharedMemory: 'gtt',
  } as const;
  if (rule === 'carve-out') return carveOut;
  if (rule === 'ttm') return shared;
  if (rule === 'prefer-gtt') return vram >= gtt ? carveOut : shared;
  return { ...(carveOut.memoryBytes <= shared.memoryBytes ? carveOut : shared), memoryUnconfirmed: true };
}

async function linuxGpu(
  root: string,
  dir: string,
  address: string,
  kfd: Map<string, KfdNode>,
  rule: KfdApuRule
): Promise<Classified> {
  const pciClass = await readText(join(dir, 'class'));
  if (!pciClass || !/^0x[0-9a-f]{6}$/i.test(pciClass)) return undefined;
  if (!pciClass.startsWith('0x03')) return null;
  const [vendorText, deviceText, driverLink] = await Promise.all([
    readText(join(dir, 'vendor')),
    readText(join(dir, 'device')),
    readlink(join(dir, 'driver')).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }),
  ]);
  if (!/^0x[0-9a-f]{4}$/i.test(vendorText ?? '') || !/^0x[0-9a-f]{4}$/i.test(deviceText ?? '')) {
    return undefined;
  }
  const vendorId = vendorText?.replace(/^0x/i, '').toLowerCase() ?? '';
  const deviceId = deviceText?.replace(/^0x/i, '').toLowerCase() ?? '';
  const vendor = VENDORS[vendorId];
  const driver = driverLink ? basename(driverLink) : null;
  if (!vendor || !driver) return null;
  const classified = async (
    memory: Pick<DetectedGpu, 'memoryBytes' | 'sharedMemory' | 'memoryUnconfirmed'>
  ): Promise<Classified> => ({
    gpu: { vendor, name: await readText(join(dir, 'product_name')), ...memory, vendorId, deviceId },
    reachable: await reachable(root, dir, driver),
  });

  if (vendor === 'nvidia') {
    // CUDA needs the proprietary driver; under nouveau only Mesa's NVK can expose the card, through Vulkan.
    const usable = driver === 'nvidia' || driver === 'nouveau';
    return usable && parseInt(deviceId, 16) >= NVIDIA_FIRST_MAXWELL_DEVICE ? classified({ memoryBytes: null }) : null;
  }
  if (vendor === 'amd') {
    if (driver !== 'amdgpu') return null;
    const vram = positive(await readText(join(dir, 'mem_info_vram_total')));
    const node = kfd.get(address);
    if (node ? node.gfxTarget === STRIX_HALO_GFX_TARGET : deviceId === STRIX_HALO_DEVICE_ID) {
      return classified(await strixHaloMemory(root, dir, vram, rule));
    }
    if (vram !== null && vram <= INTEGRATED_MAX_VRAM_BYTES) return null;
    if (node && (AMD_APU_GFX_TARGETS.has(node.gfxTarget) || node.cpuCores > 0)) return null;
    // Unless the target is a known card, an APU's firmware carve-out could pass for VRAM, so leave it unmeasured.
    return classified({ memoryBytes: node && AMD_DISCRETE_GFX_TARGETS.has(node.gfxTarget) ? vram : null });
  }
  // Intel integrated graphics sit on the root bus (00:02.0); discrete Arc cards hang off a PCIe port.
  const bus = parseInt(address.split(':')[1] ?? '', 16);
  if ((driver !== 'i915' && driver !== 'xe') || bus === 0) return null;
  // Current xe/i915 expose memory sizes through DRM ioctls, not a VRAM sysfs attribute.
  return classified({ memoryBytes: null });
}

async function pciIdsLookup(root: string): Promise<(vendorId: string, deviceId: string) => string | null> {
  let ids: string | null = null;
  for (const file of PCI_IDS_FILES) {
    ids = await readText(join(root, file));
    if (ids !== null) break;
  }
  return (vendorId, deviceId) => {
    const start = ids?.indexOf(`\n${vendorId}  `) ?? -1;
    if (!ids || start < 0) return null;
    const end = ids.slice(start + 1).search(/\n[0-9a-f]{4} {2}/);
    const block = ids.slice(start + 1, end < 0 ? undefined : start + 1 + end);
    const line = block.split('\n').find(entry => entry.startsWith(`\t${deviceId}  `));
    return line ? line.slice(deviceId.length + 3).trim() : null;
  };
}

async function isWsl(root: string, env: Environment): Promise<boolean> {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  if (/microsoft/i.test((await readText(join(root, 'proc/version'))) ?? '')) return true;
  const markers = await Promise.all(['proc/sys/fs/binfmt_misc/WSLInterop', 'dev/dxg'].map(p => exists(join(root, p))));
  return markers.includes(true);
}

/** Usable GPUs from Linux sysfs; null when they cannot be listed or opened (no PCI sysfs, WSL, Jetson, container). */
export async function scanLinuxGpus(root = '/', env: Environment = process.env): Promise<DetectedGpu[] | null> {
  const devicesDir = join(root, 'sys/bus/pci/devices');
  let addresses: string[];
  try {
    addresses = (await readdir(devicesDir)).sort();
  } catch {
    return null;
  }
  const [wsl, deviceTree, kfd, rule] = await Promise.all([
    isWsl(root, env),
    readText(join(root, 'proc/device-tree/compatible')),
    kfdNodes(root),
    kfdApuRule(root),
  ]);
  if (wsl || deviceTree?.includes('nvidia,tegra')) return null;

  const found = await Promise.all(
    addresses.map(address => linuxGpu(root, join(devicesDir, address), address, kfd, rule).catch(() => undefined))
  );
  if (found.includes(undefined)) return null;
  const usable = found.filter((entry): entry is NonNullable<Classified> => entry !== null);
  if (usable.some(entry => !entry.reachable)) return null;
  const gpus = usable.map(entry => entry.gpu);
  const lookup = gpus.some(gpu => !gpu.name) ? await pciIdsLookup(root) : null;
  return gpus.map(({ vendorId, deviceId, ...gpu }) => {
    const model = gpu.name ? null : lookup?.(vendorId, deviceId);
    const label = VENDOR_LABELS[gpu.vendor];
    return { ...gpu, name: gpu.name ?? (model ? `${label} ${model}` : `${label} GPU [${vendorId}:${deviceId}]`) };
  });
}

/** Video controllers with VRAM from each driver key's `HardwareInformation.qwMemorySize`; AdapterRAM stops at 4 GiB. */
export const WINDOWS_GPU_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $controllers = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
$rows = @($controllers | ForEach-Object {
  $enum = Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\' + $_.PNPDeviceID)
  $driver = if ($enum.Driver) { Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\' + $enum.Driver) }
  $memory = $driver.'HardwareInformation.qwMemorySize'
  if ($null -eq $memory) { $memory = $driver.'HardwareInformation.MemorySize' }
  if ($memory -is [byte[]]) { $memory = if ($memory.Length -ge 8) { [BitConverter]::ToUInt64($memory, 0) } else { [BitConverter]::ToUInt32($memory, 0) } }
  [pscustomobject]@{ name = $_.Name; pnpDeviceId = $_.PNPDeviceID; adapterRam = $_.AdapterRAM; location = $enum.LocationInformation; memoryBytes = $memory; errorCode = $_.ConfigManagerErrorCode; status = $_.Status }
})
ConvertTo-Json -InputObject $rows -Compress`;

/** Runs WINDOWS_GPU_SCRIPT by absolute path; base64 UTF-16LE sidesteps Windows command-line quoting. */
export function windowsGpuCommand(env: Environment = process.env): [string, string[]] {
  const powershell = `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const encoded = Buffer.from(WINDOWS_GPU_SCRIPT, 'utf16le').toString('base64');
  return [powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]];
}

/** APU graphics: "Radeon(TM) Graphics", "RX Vega 11 Graphics", "780M Graphics", "610M"; cards say RX or Pro. */
function isAmdApuName(name: string): boolean {
  if (/\bHD\s*\d{4}D\b/i.test(name)) return true;
  if (/\bVega \d+ Graphics\b/i.test(name)) return true;
  return !/\b(RX|Pro|FirePro|VII|HD)\b/i.test(name) && (/\bGraphics\s*$/i.test(name) || /\b\d{3,4}[MS]\b/.test(name));
}

/** The PCI bus from LocationInformation, raw (`@...pci.sys,#65536;PCI bus %1, ...;(0,2,0)`) or resolved. */
function pciBus(location: unknown): number | null {
  if (typeof location !== 'string') return null;
  const match = /;\((\d+),\d+,\d+\)\s*$/.exec(location) ?? /PCI bus (\d+),/i.exec(location);
  return match ? Number(match[1]) : null;
}

const windowsControllerSchema = z.object({
  pnpDeviceId: z.string(),
  name: z.string().nullish(),
  adapterRam: z.union([z.number(), z.string()]).nullish(),
  memoryBytes: z.union([z.number(), z.string()]).nullish(),
  location: z.string().nullish(),
  errorCode: z.number().nullish(),
  status: z.string().nullish(),
});
const windowsControllersSchema = z.union([z.array(windowsControllerSchema), windowsControllerSchema]);

/** Parses WINDOWS_GPU_SCRIPT's JSON; null when enumeration failed or the controller data is malformed. */
export function parseWindowsGpus(stdout: string): DetectedGpu[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const result = windowsControllersSchema.safeParse(parsed);
  if (!result.success) return null;
  const rows = Array.isArray(result.data) ? result.data : [result.data];
  return rows.flatMap((fields): DetectedGpu[] => {
    const disabled =
      (typeof fields.errorCode === 'number' && fields.errorCode !== 0) ||
      (typeof fields.status === 'string' && fields.status !== 'OK');
    const pnp = typeof fields.pnpDeviceId === 'string' ? fields.pnpDeviceId : '';
    const ids = /^PCI\\VEN_([0-9A-F]{4})&DEV_([0-9A-F]{4})/i.exec(pnp);
    const vendor = ids ? VENDORS[ids[1].toLowerCase()] : undefined;
    if (disabled || !ids || !vendor) return [];
    const name = typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : null;
    const adapterRam = positive(fields.adapterRam);
    const memoryBytes =
      positive(fields.memoryBytes) ?? (adapterRam !== null && adapterRam < ADAPTER_RAM_CAP ? adapterRam : null);
    const bus = pciBus(fields.location);
    const small = memoryBytes !== null && memoryBytes <= INTEGRATED_MAX_VRAM_BYTES;
    const gpu = [{ vendor, name, memoryBytes }];

    if (vendor === 'nvidia') return parseInt(ids[2], 16) >= NVIDIA_FIRST_MAXWELL_DEVICE ? gpu : [];
    if (vendor === 'amd') {
      // qwMemorySize is the Variable Graphics Memory carve-out; shared memory past it is not counted.
      if ((name && STRIX_HALO_NAME.test(name)) || ids[2].toLowerCase() === STRIX_HALO_DEVICE_ID) {
        return [{ vendor, name, memoryBytes, sharedMemory: 'carve-out' }];
      }
      // Pre-GCN Radeon HD parts have neither a ROCm nor a Vulkan backend.
      if (name && /\bHD\s*(?:[2-6]\d{3}|7[0-6]\d{2})\b/i.test(name)) return [];
      return small || (name !== null && isAmdApuName(name)) ? [] : gpu;
    }
    return bus === 0 || (bus === null && small) ? [] : gpu;
  });
}
