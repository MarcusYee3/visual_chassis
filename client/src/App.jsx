import { useState } from 'react';
import ServerForm from './components/Form/Form';
import ServerOverview from './pages/ServerOverview';
import LogFailurePanel from './components/LogFailurePanel/LogFailurePanel';
import NavMenu from './components/NavMenu/NavMenu';
import { updateServer, diagnoseServer, precheckDiagnose } from './services/api';
import { getLoggableParts } from './utils/loggableParts';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [], dimmIds: [] };

// Matches the Form/LogFailurePanel card language (dot-pattern background, subtle border, soft
// shadow) instead of the bare unstyled <p> tags this used to be — those read as loose, uncontained
// text floating below the form rather than a distinct status area.
const statusCardStyle = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: '11px',
  padding: '12px 14px',
  borderRadius: '6px',
  border: '1px solid #33405a',
  backgroundImage:
    'radial-gradient(circle at 3px 3px, rgba(168, 196, 232, 0.05) 0.5px, transparent 0.5px), linear-gradient(180deg, #1c2333 0%, #161b28 100%)',
  backgroundSize: '6px 6px, 100% 100%',
  boxShadow: '0 4px 14px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [faults, setFaults] = useState(EMPTY_FAULTS);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState('');
  const [diagnoseStatus, setDiagnoseStatus] = useState('');
  const [flowNotice, setFlowNotice] = useState('');
  const [loadingNotice, setLoadingNotice] = useState('');
  const [logPanel, setLogPanel] = useState(null); // { serialNumber, parts, checkName, source }

  const handleFormSubmit = async (formData) => {
    await updateServer('server-1', { serialNumber: formData.sn });
    setFaults(EMPTY_FAULTS);
    setRefreshKey((k) => k + 1);
    setLogPanel(null);

    setDiagnosing(true);
    setDiagnoseError('');
    setDiagnoseStatus('');
    setFlowNotice('');
    setLoadingNotice('');

    // The real diagnose request takes tens of seconds (ILOM SSH round-trips); precheck is a
    // near-instant read of the same decision it's about to make (mfg-collector cache, or the
    // supplied Jira ticket if given priority), so the loading state can show something specific
    // (e.g. "No mfg-collector record found...") in place of a generic "Running diagnostics…" the
    // whole time. Best-effort — if it fails for any reason, just fall back to the generic message
    // rather than blocking the real request on it.
    try {
      const precheck = await precheckDiagnose('server-1', formData.sn, formData.jiraLink);
      setLoadingNotice(precheck.targetedCheckName
        ? `Running targeted check: ${precheck.targetedCheckName}…`
        : (precheck.notice || 'Running diagnostics…'));
    } catch {
      setLoadingNotice('Running diagnostics…');
    }

    try {
      const result = await diagnoseServer('server-1', formData.sn, formData.ilomIp, formData.jiraLink);
      const f = result.faults ?? EMPTY_FAULTS;
      setFaults(f);
      setFlowNotice(result.defaultFlowNotice || '');
      const hasFaults = f.components.length > 0 || (f.genericErrors || []).length > 0;
      // Any source that isn't the "default-ilom-chain (...)" tag means the response came from a
      // short-circuit (a matched targeted check, a forced check, or faults already documented in
      // a Jira ticket's comments) — the ILOM SSH chain was never opened for it.
      const isTargetedSource = !!result.source && !result.source.startsWith('default-ilom-chain');
      const isCheckMatch = result.source?.includes(' -> ');
      const via = isTargetedSource ? ` (via ${isCheckMatch ? result.source.split(' -> ')[0] : result.source}, ILOM not checked)` : '';
      setDiagnoseStatus(!hasFaults
        ? 'No open problems detected.'
        : `Faults detected${via}: ${f.components.length > 0 ? f.components.join(', ') : 'see error below'}`);

      const parts = getLoggableParts(f);
      if (parts.length > 0) {
        const checkName = isCheckMatch ? result.source.split(' -> ')[1] : undefined;
        setLogPanel({ serialNumber: formData.sn, parts, checkName, source: result.source });
      }
    } catch (e) {
      setDiagnoseError(e.message || 'Diagnosis failed');
    } finally {
      setDiagnosing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '20px' }}>
      <div style={{ alignSelf: 'stretch', display: 'flex', justifyContent: 'flex-end' }}>
        <NavMenu />
      </div>
      {/* gap is wider than it looks like it needs to be — the chassis's U-height labels and left
          rack ear are absolutely positioned outside its own 740px layout box (see
          ServerContainer.module.css), so a smaller gap here crowds right into that decoration. */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '70px' }}>
        <div style={{ width: '300px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <ServerForm onSubmit={handleFormSubmit} />
          {(diagnosing || flowNotice || diagnoseStatus) && (
            <div style={statusCardStyle}>
              {diagnosing && <p style={{ color: '#8a9ab0', margin: 0 }}>{loadingNotice || 'Running diagnostics…'}</p>}
              {!diagnosing && flowNotice && <p style={{ color: '#8a9ab0', margin: 0 }}>{flowNotice}</p>}
              {!diagnosing && diagnoseStatus && (
                <p style={{ color: diagnoseStatus.startsWith('Faults') ? '#ff8080' : '#7ad67a', margin: 0 }}>{diagnoseStatus}</p>
              )}
            </div>
          )}
        </div>
        <ServerOverview refreshKey={refreshKey} faults={faults} />
      </div>
      {/* diagnoseError and LogFailurePanel both get their own full-width row below the sidebar
          (rather than squeezed into the 300px sidebar column, where the error text used to
          collide with the chassis's absolutely-positioned U-height labels/rack ear that extend
          left of its own 740px layout box — see the gap comment above) so they can use the full
          740px width instead of being capped at 300px. */}
      {diagnoseError && (
        <div style={{ ...statusCardStyle, width: '100%', maxWidth: '740px' }}>
          <p style={{ color: '#ff8080', margin: 0 }}>{diagnoseError}</p>
        </div>
      )}
      {logPanel && (
        <LogFailurePanel
          serialNumber={logPanel.serialNumber}
          parts={logPanel.parts}
          checkName={logPanel.checkName}
          source={logPanel.source}
          onDismiss={() => setLogPanel(null)}
        />
      )}
    </div>
  );
}

export default App;
