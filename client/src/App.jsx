import { useState } from 'react';
import { Link } from 'react-router-dom';
import ServerForm from './components/Form/Form';
import ServerOverview from './pages/ServerOverview';
import LogFailurePanel from './components/LogFailurePanel/LogFailurePanel';
import { updateServer, diagnoseServer } from './services/api';
import { getLoggableParts } from './utils/loggableParts';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [], genericErrors: [], cableFaults: [], pcieSwitchIds: [] };

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [faults, setFaults] = useState(EMPTY_FAULTS);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState('');
  const [diagnoseStatus, setDiagnoseStatus] = useState('');
  const [logPanel, setLogPanel] = useState(null); // { serialNumber, parts, checkName, source }

  const handleFormSubmit = async (formData) => {
    await updateServer('server-1', { serialNumber: formData.sn });
    setFaults(EMPTY_FAULTS);
    setRefreshKey((k) => k + 1);
    setLogPanel(null);

    setDiagnosing(true);
    setDiagnoseError('');
    setDiagnoseStatus('');
    try {
      const result = await diagnoseServer('server-1', formData.sn, formData.ilomIp);
      const f = result.faults ?? EMPTY_FAULTS;
      setFaults(f);
      const hasFaults = f.components.length > 0 || (f.genericErrors || []).length > 0;
      const via = result.source?.startsWith('mfg-collector') ? ' (via mfg-collector, ILOM not checked)' : '';
      setDiagnoseStatus(!hasFaults
        ? 'No open problems detected.'
        : `Faults detected${via}: ${f.components.length > 0 ? f.components.join(', ') : 'see error below'}`);

      const parts = getLoggableParts(f);
      if (parts.length > 0) {
        const checkName = result.source?.startsWith('mfg-collector -> ') ? result.source.split(' -> ')[1] : undefined;
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
        <Link to="/failures" style={{ color: '#a8c4e8', fontSize: '11px', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none' }}>
          Failure Log →
        </Link>
      </div>
      <ServerForm onSubmit={handleFormSubmit} />
      {diagnosing && <p style={{ color: '#aaa' }}>Running diagnostics…</p>}
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
