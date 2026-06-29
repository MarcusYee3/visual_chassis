import { useState } from 'react';
import ServerForm from './components/Form/Form';
import ServerOverview from './pages/ServerOverview';
import { updateServer } from './services/api';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [] };

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [faults, setFaults] = useState(EMPTY_FAULTS);

  const handleFormSubmit = async (formData) => {
    await updateServer('server-1', { serialNumber: formData.sn });
    setFaults(EMPTY_FAULTS);
    setRefreshKey((k) => k + 1);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '20px' }}>
      <ServerForm onSubmit={handleFormSubmit} />
      <ServerOverview refreshKey={refreshKey} faults={faults} />
    </div>
  );
}

export default App;
