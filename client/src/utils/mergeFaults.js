// Mirrors server/src/routes/diagnose.js's (now-removed) mergeFaults exactly — the default ILOM
// chain streams one partial fault fragment per command as it completes instead of one final
// merged blob (see diagnoseServer in services/api.js), so callers accumulate them client-side:
// unioning each array field (deduped) rather than overwriting, since a unit can have more than one
// real problem at once (e.g. a fabric-test PCIe failure *and* a GXR3 firmware failure).
export function mergeFaultsClient(a, b) {
  const merged = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };
  const seen = { components: new Set(), psuPorts: new Set(), retimerIds: new Set(), e1sIds: new Set(), fanIds: new Set(), cableFaults: new Set(), pcieFaults: new Set(), pcieSwitchIds: new Set(), dimmIds: new Set() };
  for (const f of [a, b]) {
    if (!f) continue;
    for (const key of ['components', 'psuPorts', 'retimerIds', 'e1sIds', 'fanIds', 'cableFaults', 'pcieSwitchIds', 'dimmIds']) {
      for (const id of f[key] || []) {
        if (!seen[key].has(id)) { seen[key].add(id); merged[key].push(id); }
      }
    }
    for (const p of f.pcieFaults || []) {
      const key = p.resource || `${p.iou}-${p.pcie}`;
      if (!seen.pcieFaults.has(key)) { seen.pcieFaults.add(key); merged.pcieFaults.push(p); }
    }
    for (const g of f.genericErrors || []) merged.genericErrors.push(g);
  }
  return merged;
}
