import { useState } from 'react';
import ServerForm from './components/Form/Form';
import ServerOverview from './pages/ServerOverview';
import LogFailurePanel from './components/LogFailurePanel/LogFailurePanel';
import NavMenu from './components/NavMenu/NavMenu';
import { updateServer, diagnoseServer, precheckDiagnose } from './services/api';
import { getLoggableParts } from './utils/loggableParts';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [] };

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
      <div style={{ width: '100%', maxWidth: '740px', display: 'flex', justifyContent: 'flex-end' }}>
        <NavMenu />
      </div>
      <ServerForm onSubmit={handleFormSubmit} />
      {diagnosing && <p style={{ color: '#aaa' }}>{loadingNotice || 'Running diagnostics…'}</p>}
      {!diagnosing && flowNotice && <p style={{ color: '#aaa' }}>{flowNotice}</p>}
      {!diagnosing && diagnoseStatus && <p style={{ color: diagnoseStatus.startsWith('Faults') ? 'red' : 'green' }}>{diagnoseStatus}</p>}
      {diagnoseError && <p style={{ color: 'red' }}>{diagnoseError}</p>}
      {logPanel && (
        <LogFailurePanel
          serialNumber={logPanel.serialNumber}
          parts={logPanel.parts}
          checkName={logPanel.checkName}
          source={logPanel.source}
          onDismiss={() => setLogPanel(null)}
        />
      )}
      <ServerOverview refreshKey={refreshKey} faults={faults} />
    </div>
  );
}

export default App;
