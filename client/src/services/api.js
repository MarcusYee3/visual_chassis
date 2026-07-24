const API_BASE = '/api';

// Reads the body as JSON when possible, without letting a non-JSON body (e.g. an
// HTML error page from an unreachable backend or a proxy) throw a raw parse error.
async function handleResponse(response, fallbackError) {
  let data = null;
  try {
    data = await response.json();
  } catch {
    // non-JSON body — fall through to the status-based error below
  }
  if (!response.ok) {
    throw new Error(data?.error || `${fallbackError} (HTTP ${response.status})`);
  }
  return data;
}

export const getServer = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}`);
  return handleResponse(response, 'Failed to fetch server');
};

export const updateServer = async (serverId, updates) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return handleResponse(response, 'Failed to update server');
};

export const getGBBTray = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb`);
  return handleResponse(response, 'Failed to fetch GBB tray');
};

export const getOSFPModules = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp`);
  return handleResponse(response, 'Failed to fetch OSFP modules');
};

export const getOSFPModule = async (serverId, osfpId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}`);
  return handleResponse(response, 'Failed to fetch OSFP module');
};

export const getPCIePorts = async (serverId, osfpId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}/pcie`);
  return handleResponse(response, 'Failed to fetch PCIe ports');
};

export const getPSUPorts = async (serverId) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/psu`);
  return handleResponse(response, 'Failed to fetch PSU ports');
};

export const validateSerialNumber = async (sn) => {
  const response = await fetch(`${API_BASE}/validate-sn?sn=${encodeURIComponent(sn)}`);
  return handleResponse(response, 'Validation request failed');
};

// GET /servers/:id/diagnose streams newline-delimited JSON instead of one big JSON body — the
// default ILOM chain runs many commands unconditionally, and a single slow/timing-out one used to
// abort the whole response, discarding every fault already found. onEvent(event) is called for
// each line as it arrives, in order; event.type is one of:
//   'partial' {label, faults, raw}        — merge `faults` into the running total immediately
//   'fatal'   {error}                     — unrecoverable (e.g. ILOM down); stream ends after this
//   'done'    {source, defaultFlowNotice} — stream finished, these are the final status fields
export const diagnoseServer = async (serverId, serialNumber, ilomIp, jiraLink, onEvent) => {
  const params = new URLSearchParams({ serialNumber });
  if (ilomIp) params.set('ilomIp', ilomIp);
  if (jiraLink) params.set('jiraLink', jiraLink);
  const response = await fetch(`${API_BASE}/servers/${serverId}/diagnose?${params}`);
  if (!response.ok) {
    // Only the pre-stream validation checks (missing/invalid serial number) respond this way —
    // every other failure mode is a {type:'fatal'} line in the stream body instead, since by the
    // time those can happen the response headers are already committed to the ndjson content type.
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON body */ }
    throw new Error(data?.error || `Diagnose failed (HTTP ${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
};

// Instant (cache-only, no ILOM SSH) read of what diagnoseServer will do for this SN — lets the
// caller show an accurate status (e.g. "No mfg-collector record found...") while the real,
// much slower diagnose request is still in flight, instead of a generic loading message.
export const precheckDiagnose = async (serverId, serialNumber, jiraLink) => {
  const params = new URLSearchParams({ serialNumber });
  if (jiraLink) params.set('jiraLink', jiraLink);
  const response = await fetch(`${API_BASE}/servers/${serverId}/diagnose/precheck?${params}`);
  return handleResponse(response, 'Precheck failed');
};

export const checkPartFailure = async (serialNumber, partId) => {
  const params = new URLSearchParams({ serialNumber, partId });
  const response = await fetch(`${API_BASE}/part-failures?${params}`);
  return handleResponse(response, 'Failed to check part failure log');
};

export const logPartFailure = async (entry) => {
  const response = await fetch(`${API_BASE}/part-failures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  return handleResponse(response, 'Failed to log part failure');
};

export const getAllPartFailures = async () => {
  const response = await fetch(`${API_BASE}/part-failures`);
  return handleResponse(response, 'Failed to fetch part failure log');
};

export const updatePCIePort = async (serverId, osfpId, pcieId, status) => {
  const response = await fetch(`${API_BASE}/servers/${serverId}/gbb/osfp/${osfpId}/pcie/${pcieId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  return handleResponse(response, 'Failed to update PCIe port');
};
