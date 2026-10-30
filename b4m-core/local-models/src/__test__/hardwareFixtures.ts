import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PciDeviceFixture {
  address: string;
  pciClass: string;
  vendor: string;
  device: string;
  /** Kernel driver the device is bound to; omitted for an unbound device. */
  driver?: string;
  /** Extra files under the device directory, such as `mem_info_vram_total`. */
  files?: Record<string, string>;
}

export interface SysfsFixture {
  devices?: PciDeviceFixture[];
  /** Raw `properties` text per KFD topology node. */
  kfdNodes?: string[];
  procVersion?: string;
  deviceTreeCompatible?: string;
  pciIds?: string;
  /** False leaves out `/sys/bus/pci`, as in a sandbox without sysfs. */
  pci?: boolean;
  /** False leaves out `/dev/dri` and `/dev/nvidiactl`, as in a container started without the GPU. */
  devNodes?: boolean;
  /** Extra files relative to the root, such as `dev/dxg`. */
  files?: Record<string, string>;
}

const LINUX_VERSION = 'Linux version 6.8.0-142-generic (buildd@lcy02-amd64-049) #142-Ubuntu SMP PREEMPT_DYNAMIC\n';

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Builds a minimal `/sys`, `/proc` and `/dev` tree; each bound display device gets a render node. */
export function sysfsTree(fixture: SysfsFixture): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'local-models-sysfs-'));
  write(join(root, 'proc/version'), fixture.procVersion ?? LINUX_VERSION);
  if (fixture.deviceTreeCompatible) write(join(root, 'proc/device-tree/compatible'), fixture.deviceTreeCompatible);
  if (fixture.pciIds) write(join(root, 'usr/share/misc/pci.ids'), fixture.pciIds);
  for (const [path, content] of Object.entries(fixture.files ?? {})) write(join(root, path), content);
  if (fixture.pci !== false) {
    mkdirSync(join(root, 'sys/bus/pci/devices'), { recursive: true });
    mkdirSync(join(root, 'sys/bus/pci/drivers'), { recursive: true });
  }
  let renderMinor = 128;
  for (const device of fixture.devices ?? []) {
    const dir = join(root, 'sys/bus/pci/devices', device.address);
    write(join(dir, 'class'), `${device.pciClass}\n`);
    write(join(dir, 'vendor'), `${device.vendor}\n`);
    write(join(dir, 'device'), `${device.device}\n`);
    for (const [name, content] of Object.entries(device.files ?? {})) write(join(dir, name), `${content}\n`);
    if (!device.driver) continue;
    mkdirSync(join(root, 'sys/bus/pci/drivers', device.driver), { recursive: true });
    symlinkSync(`../../../bus/pci/drivers/${device.driver}`, join(dir, 'driver'));
    if (!device.pciClass.startsWith('0x03')) continue;
    const render = `renderD${renderMinor++}`;
    mkdirSync(join(dir, 'drm', render), { recursive: true });
    if (fixture.devNodes !== false) {
      write(join(root, 'dev/dri', render), '');
      if (device.driver === 'nvidia') write(join(root, 'dev/nvidiactl'), '');
    }
  }
  (fixture.kfdNodes ?? []).forEach((properties, index) =>
    write(join(root, 'sys/class/kfd/kfd/topology/nodes', String(index), 'properties'), properties)
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const PCI_IDS = `# Excerpt of the pci.ids database
#
1002  Advanced Micro Devices, Inc. [AMD/ATI]
\t15bf  Phoenix1
\t164e  Raphael
\t744c  Navi 31 [Radeon RX 7900 XT/7900 XTX/7900 GRE/7900M]
\t\t1002 0e3b  Radeon RX 7900 XTX
10de  NVIDIA Corporation
\t0a65  GT218 [GeForce 210]
\t2684  AD102 [GeForce RTX 4090]
8086  Intel Corporation
\t56a0  DG2 [Arc A770]
\ta7a0  Raptor Lake-P [Iris Xe Graphics]
\te20b  Battlemage G21 [Arc B580]
`;

const bridge = (address: string): PciDeviceFixture => ({
  address,
  pciClass: '0x060400',
  vendor: '0x1022',
  device: '0x1483',
  driver: 'pcieport',
});

export const intelIgpu: PciDeviceFixture = {
  address: '0000:00:02.0',
  pciClass: '0x030000',
  vendor: '0x8086',
  device: '0xa7a0',
  driver: 'i915',
};

export const aspeedBmc: PciDeviceFixture = {
  address: '0000:c2:00.0',
  pciClass: '0x030000',
  vendor: '0x1a03',
  device: '0x2000',
  driver: 'ast',
};

export const amdRx7900xtx: PciDeviceFixture = {
  address: '0000:03:00.0',
  pciClass: '0x030000',
  vendor: '0x1002',
  device: '0x744c',
  driver: 'amdgpu',
  files: { mem_info_vram_total: '25753026560', mem_info_vram_used: '1185984512' },
};

/** Raphael's iGPU with the default 512 MiB carve-out, at the address of the KFD capture below. */
export const amdRaphaelIgpu: PciDeviceFixture = {
  address: '0000:15:00.0',
  pciClass: '0x030000',
  vendor: '0x1002',
  device: '0x164e',
  driver: 'amdgpu',
  files: { mem_info_vram_total: '536870912', mem_info_vram_used: '75235328' },
};

// KFD nodes of a Ryzen 9 7900 + RX 7900 XTX machine, trimmed from a dump posted in an Ollama GitHub issue about a
// discrete AMD GPU going unused. The Raphael iGPU node reports cpu_cores_count 0 like the discrete card.
export const KFD_CPU_NODE =
  'cpu_cores_count 24\nsimd_count 0\nmem_banks_count 1\ngfx_target_version 0\nvendor_id 0\ndevice_id 0\nlocation_id 0\ndomain 0\ndrm_render_minor 0\n';
export const KFD_RX7900XTX_NODE =
  'cpu_cores_count 0\nsimd_count 192\nmem_banks_count 1\narray_count 12\nsimd_per_cu 2\ngfx_target_version 110000\nvendor_id 4098\ndevice_id 29772\nlocation_id 768\ndomain 0\ndrm_render_minor 128\nnum_xcc 1\n';
export const KFD_RAPHAEL_NODE =
  'cpu_cores_count 0\nsimd_count 4\nmem_banks_count 1\narray_count 1\nsimd_per_cu 2\ngfx_target_version 100306\nvendor_id 4098\ndevice_id 5710\nlocation_id 5376\ndomain 0\ndrm_render_minor 129\nnum_xcc 1\n';

/** Strix Halo on 128 GB with a 64 GiB firmware carve-out, and GTT at its default half of the RAM the OS sees. */
export const amdStrixHalo: PciDeviceFixture = {
  address: '0000:c5:00.0',
  pciClass: '0x038000',
  vendor: '0x1002',
  device: '0x1586',
  driver: 'amdgpu',
  files: { mem_info_vram_total: '68719476736', mem_info_gtt_total: '33285996544' },
};

/** Strix Halo with this carve-out and GTT size, in bytes. */
export const strixHalo = (vram: number, gtt: number): PciDeviceFixture => ({
  ...amdStrixHalo,
  files: { mem_info_vram_total: String(vram), mem_info_gtt_total: String(gtt) },
});

// gfx_target_version, vendor_id, device_id, simd_count and drm_render_minor are from a public gfx1151 (Ryzen AI
// Max+ 395) rocminfo bug report; location_id (bus 0xc5), domain and cpu_cores_count are filled in for this fixture.
export const KFD_STRIX_HALO_NODE =
  'cpu_cores_count 0\nsimd_count 80\ngfx_target_version 110501\nvendor_id 4098\ndevice_id 5510\nlocation_id 50432\ndomain 0\ndrm_render_minor 128\n';

export const intelArcB580Xe: PciDeviceFixture = {
  address: '0000:04:00.0',
  pciClass: '0x030000',
  vendor: '0x8086',
  device: '0xe20b',
  driver: 'xe',
};

export const intelArcA770I915: PciDeviceFixture = {
  address: '0000:04:00.0',
  pciClass: '0x030000',
  vendor: '0x8086',
  device: '0x56a0',
  driver: 'i915',
};

export const nvidiaRtx4090: PciDeviceFixture = {
  address: '0000:01:00.0',
  pciClass: '0x030000',
  vendor: '0x10de',
  device: '0x2684',
  driver: 'nvidia',
};

/** Pre-Maxwell, on nouveau. */
export const nvidiaGt218Nouveau: PciDeviceFixture = {
  address: '0000:41:00.0',
  pciClass: '0x030000',
  vendor: '0x10de',
  device: '0x0a65',
  driver: 'nouveau',
};

export const pcieBridges = [bridge('0000:00:01.1'), bridge('0000:40:03.1')];

/** The registry's raw LocationInformation: a MUI indirect string ending in the (bus,device,function) tuple. */
export const rawLocation = (bus: number, device: number) =>
  `@System32\\drivers\\pci.sys,#65536;PCI bus %1, device %2, function %3;(${bus},${device},0)`;

/** The script's `ConvertTo-Json -Compress` output; Windows PowerShell 5.1 writes `&` as a JSON unicode escape. */
export const POWERSHELL_INTEL_IGPU_ONLY = JSON.stringify([
  {
    name: 'Intel(R) Iris(R) Xe Graphics',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_A7A0&SUBSYS_0B131028&REV_04\\3&11583659&0&10',
    adapterRam: 134217728,
    location: rawLocation(0, 2),
    memoryBytes: 134217728,
    errorCode: 0,
    status: 'OK',
  },
  {
    name: 'Microsoft Remote Display Adapter',
    pnpDeviceId: 'SWD\\REMOTEDISPLAYENUM\\RDPIDD_INDIRECTDISPLAY&SESSIONID_0002',
    adapterRam: null,
    location: null,
    memoryBytes: null,
    errorCode: 0,
    status: 'OK',
  },
]).replace(/&/g, '\\u0026');

export const POWERSHELL_AMD_DISCRETE_AND_APU = JSON.stringify([
  {
    name: 'AMD Radeon RX 7900 XTX',
    pnpDeviceId: 'PCI\\VEN_1002&DEV_744C&SUBSYS_0E3B1002&REV_C8\\6&2C5F5F5A&0&00000019',
    adapterRam: 4293918720,
    location: 'PCI bus 3, device 0, function 0',
    memoryBytes: 25753026560,
    errorCode: 0,
    status: 'OK',
  },
  {
    name: 'AMD Radeon(TM) Graphics',
    pnpDeviceId: 'PCI\\VEN_1002&DEV_164E&SUBSYS_D0001458&REV_C1\\4&1F8C5D2B&0&0041',
    adapterRam: 536870912,
    location: 'PCI bus 21, device 0, function 0',
    memoryBytes: 536870912,
    errorCode: 0,
    status: 'OK',
  },
]).replace(/&/g, '\\u0026');

/** A single controller: ConvertTo-Json -InputObject keeps it an array, but older shells may not. */
export const POWERSHELL_INTEL_ARC = JSON.stringify({
  name: 'Intel(R) Arc(TM) A770 Graphics',
  pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_10208086&REV_08\\6&1B2A3C4D&0&00080008',
  adapterRam: 4293918720,
  location: rawLocation(4, 0),
  memoryBytes: 17079205888,
  errorCode: 0,
  status: 'OK',
});

/** A Ryzen AI Max+ 395 with 96 GB of its 128 GB set as Variable Graphics Memory. */
export const POWERSHELL_STRIX_HALO = JSON.stringify([
  {
    name: 'AMD Radeon(TM) 8060S Graphics',
    pnpDeviceId: 'PCI\\VEN_1002&DEV_1586&SUBSYS_8D101462&REV_C1\\4&2A9E7E3B&0&0041',
    adapterRam: 4293918720,
    location: 'PCI bus 197, device 0, function 0',
    memoryBytes: 103079215104,
    errorCode: 0,
    status: 'OK',
  },
]).replace(/&/g, '\\u0026');

export const POWERSHELL_NVIDIA = JSON.stringify([
  {
    name: 'NVIDIA GeForce RTX 4090',
    pnpDeviceId: 'PCI\\VEN_10DE&DEV_2684&SUBSYS_889D1043&REV_A1\\4&2283F625&0&0019',
    adapterRam: 4293918720,
    location: 'PCI bus 1, device 0, function 0',
    memoryBytes: 25757220864,
    errorCode: 0,
    status: 'OK',
  },
]);
