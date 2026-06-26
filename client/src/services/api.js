const API_BASE = '/api';

// Server operations
export const getServer = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch server');
  }
  return response.json();
};

export const updateServer = async (serverId, updates) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    throw new Error('Failed to update server');
  }
  return response.json();
};

// GBB Tray operations
export const getGBBTray = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb`);
  if (!response.ok) {
    throw new Error('Failed to fetch GBB tray');
  }
  return response.json();
};

// OSFP operations
export const getOSFPModules = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp`);
  if (!response.ok) {
    throw new Error('Failed to fetch OSFP modules');
  }
  return response.json();
};

export const getOSFPModule = async (serverId, osfpId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch OSFP module');
  }
  return response.json();
};

// PCIe operations
export const getPCIePorts = async (serverId, osfpId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}/pcie`);
  if (!response.ok) {
    throw new Error('Failed to fetch PCIe ports');
  }
  return response.json();
};

// PSU operations
export const getPSUPorts = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/psu`);
  if (!response.ok) {
    throw new Error('Failed to fetch PSU ports');
  }
  return response.json();
};

// Report operations
export const getRecordsBySerial = async (serialNumber) => {
  const response = await fetch(`${API_BASE}/reports/serial/${serialNumber}`);
  if (!response.ok) {
    throw new Error('Failed to fetch records by serial');
  }
  return response.json();
};

export const updatePCIePort = async (serverId, osfpId, pcieId, status) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}/pcie/${pcieId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    throw new Error('Failed to update PCIe port');
  }
  return response.json();
};
