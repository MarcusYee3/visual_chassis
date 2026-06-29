const API_BASE = '/api';

export const getServer = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}`);
  if (!response.ok) throw new Error('Failed to fetch server');
  return response.json();
};

export const updateServer = async (serverId, updates) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) throw new Error('Failed to update server');
  return response.json();
};

export const getGBBTray = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb`);
  if (!response.ok) throw new Error('Failed to fetch GBB tray');
  return response.json();
};

export const getOSFPModules = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp`);
  if (!response.ok) throw new Error('Failed to fetch OSFP modules');
  return response.json();
};

export const getOSFPModule = async (serverId, osfpId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}`);
  if (!response.ok) throw new Error('Failed to fetch OSFP module');
  return response.json();
};

export const getPCIePorts = async (serverId, osfpId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}/pcie`);
  if (!response.ok) throw new Error('Failed to fetch PCIe ports');
  return response.json();
};

export const getPSUPorts = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/psu`);
  if (!response.ok) throw new Error('Failed to fetch PSU ports');
  return response.json();
};

export const validateSerialNumber = async (sn) => {
  const response = await fetch(`${API_BASE}/validate-sn?sn=${encodeURIComponent(sn)}`);
  if (!response.ok) throw new Error('Validation request failed');
  return response.json();
};

export const diagnoseServer = async (serverId, serialNumber) => {
  const response = await fetch(
    `${API_BASE}/servers/${serverId}/diagnose?serialNumber=${encodeURIComponent(serialNumber)}`
  );
  if (!response.ok) throw new Error('Diagnose failed');
  return response.json();
};

export const updatePCIePort = async (serverId, osfpId, pcieId, status) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}/pcie/${pcieId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new Error('Failed to update PCIe port');
  return response.json();
};
