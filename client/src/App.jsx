import { useState } from 'react';
import ServerForm from './components/Form/Form';
import ServerOverview from './pages/ServerOverview';
import Note from './components/Note/Note';
import { updateServer } from './services/api';

const EMPTY_FAULTS = { components: [], psuPorts: [], retimerIds: [], e1sIds: [] };

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [records, setRecords] = useState([]);
  const [serialNumber, setSerialNumber] = useState('');
  const [faults, setFaults] = useState(EMPTY_FAULTS);

  const handleFormSubmit = async (formData, reportRecords) => {
    await updateServer('server-1', { serialNumber: formData.sn });
    setSerialNumber(formData.sn);
    setRecords(reportRecords);
    setRefreshKey((k) => k + 1);
  };

  const handleHighlight = (info) => {
    if (!info) {
      setFaults(EMPTY_FAULTS);
      return;
    }
    setFaults(info.faults ?? EMPTY_FAULTS);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '20px' }}>
      <ServerForm onSubmit={handleFormSubmit} />
      <div style={{ display: 'flex', gap: '40px', alignItems: 'flex-start' }}>
        <ServerOverview refreshKey={refreshKey} faults={faults} />
        <Note records={records} onHighlight={handleHighlight} serialNumber={serialNumber} />
      </div>
    </div>
  );
}

export default App;
