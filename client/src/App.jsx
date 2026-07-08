import { useState } from 'react';
import ServerForm from './components/Form/Form';
import ServerOverview from './pages/ServerOverview';
import { updateServer, diagnoseServer } from './services/api';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [], pcieFaults: [], fanIds: [] };

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [faults, setFaults] = useState(EMPTY_FAULTS);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnoseError, setDiagnoseError] = useState('');
  const [diagnoseStatus, setDiagnoseStatus] = useState('');

  const handleFormSubmit = async (formData) => {
    await updateServer('server-1', { serialNumber: formData.sn });
    setFaults(EMPTY_FAULTS);
    setRefreshKey((k) => k + 1);

    setDiagnosing(true);
    setDiagnoseError('');
    setDiagnoseStatus('');
    try {
      const result = await diagnoseServer('server-1', formData.sn, formData.ilomIp);
      const f = result.faults ?? EMPTY_FAULTS;
      setFaults(f);
      setDiagnoseStatus(f.components.length === 0 ? 'No open problems detected.' : `Faults detected: ${f.components.join(', ')}`);
    } catch (e) {
      setDiagnoseError(e.message || 'Diagnosis failed');
    } finally {
      setDiagnosing(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '20px' }}>
      <h1>Hyve ODM LionKing B300 <span>JBOG Overview</span></h1>
      <ServerForm onSubmit={handleFormSubmit} />
      {diagnosing && <p style={{ color: '#aaa' }}>Running diagnostics…</p>}
      {!diagnosing && diagnoseStatus && <p style={{ color: diagnoseStatus.startsWith('Faults') ? 'red' : 'green' }}>{diagnoseStatus}</p>}
      {diagnoseError && <p style={{ color: 'red' }}>{diagnoseError}</p>}
      <ServerOverview refreshKey={refreshKey} faults={faults} />
    </div>
  );
}

export default App;
