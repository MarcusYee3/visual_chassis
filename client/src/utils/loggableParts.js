// Derives a list of specific, individually-loggable faulted parts from a /diagnose faults
// response, so the "log this failure" UI can offer one button per distinct part instead of one
// blob for the whole result. partId must stay stable across queries for the same real part, since
// it's the dedupe key the server checks for "already logged" prompts.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function getLoggableParts(faults) {
  if (!faults) return [];
  const parts = [];

  (faults.psuPorts || []).forEach((id) => {
    const num = parseInt(id.replace(/\D/g, ''), 10);
    parts.push({ partId: id, partLabel: `PSU ${num}` });
  });

  (faults.cableFaults || []).forEach((id) => {
    const m = id.match(/^cable-(\d+)-(\d+)$/);
    parts.push({ partId: id, partLabel: m ? `Cable IOU${m[1]}↔IOU${m[2]}` : id });
  });

  (faults.pcieFaults || []).forEach((f) => {
    parts.push({ partId: `pcie-iou${f.iou}-${f.pcie}`, partLabel: f.resource || `IOU${f.iou} PCIE${f.pcie}` });
  });

  (faults.retimerIds || []).forEach((id) => {
    const num = parseInt(String(id).replace(/\D/g, ''), 10);
    parts.push({ partId: `retimer-${num}`, partLabel: `Retimer ${num}` });
  });

  (faults.e1sIds || []).forEach((id) => {
    parts.push({ partId: id, partLabel: `E1S ${id.replace('e1s-', '').toUpperCase()}` });
  });

  (faults.fanIds || []).forEach((id) => {
    const num = parseInt(String(id).replace(/\D/g, ''), 10);
    parts.push({ partId: `fan-${num}`, partLabel: `Fan ${num}` });
  });

  (faults.genericErrors || []).forEach((msg) => {
    parts.push({ partId: `generic-${hashString(msg)}`, partLabel: msg.length > 80 ? `${msg.slice(0, 80)}…` : msg });
  });

  return parts;
}
