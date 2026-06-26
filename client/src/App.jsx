import { useState } from 'react';
import ServerForm from './components/Form/Form';
import ServerOverview from './pages/ServerOverview';
import Note from './components/Note/Note';
import { updateServer } from './services/api';

function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [records, setRecords] = useState([]);
  const [highlight, setHighlight] = useState(null);

  const handleFormSubmit = async (formData, reportRecords) => {
    await updateServer('server-1', { serialNumber: formData.sn });
    setRecords(reportRecords);
    setRefreshKey((k) => k + 1);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '100vh', padding: '20px', gap: '20px' }}>
      <ServerForm onSubmit={handleFormSubmit} />
      <div style={{ display: 'flex', gap: '40px', alignItems: 'flex-start' }}>
        <ServerOverview refreshKey={refreshKey} highlight={highlight} />
        <Note records={records} onHighlight={setHighlight} />
      </div>
    </div>
  );
}

export default App;
