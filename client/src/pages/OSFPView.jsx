import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import ServerContainer from '../components/ServerContainer/ServerContainer';
import OSFPModule from '../components/OSFPModules/OSFPModule';
import BackButton from '../components/common/BackButton';
import { getOSFPModules, getServer } from '../services/api';

function OSFPView() {
  const navigate = useNavigate();
  const [server, setServer] = useState(null);
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [serverData, osfpData] = await Promise.all([
          getServer('server-1'),
          getOSFPModules('server-1')
        ]);
        setServer(serverData);
        setModules(osfpData);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '50px' }}>
        <p>Loading OSFP modules...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '50px', color: '#e74c3c' }}>
        <p>Error loading OSFP modules: {error}</p>
      </div>
    );
  }

  const handleOsfpClick = (osfpId) => {
    navigate(`/osfp/${osfpId}`);
  };

  const handleBackClick = () => {
    navigate('/');
  };

  return (
    <div>
      {server && <h1>{server.name} SN: {server.serialNumber}</h1>}
      <ServerContainer>
        <div style={{ display: 'flex', gap: '10px' }}>
          {modules.map((module) => (
            <OSFPModule
              key={module.id}
              id={module.id}
              name={module.name}
              onClick={() => handleOsfpClick(module.id)}
            />
          ))}
        </div>
        <BackButton
          onClick={handleBackClick}
          label="← Back to GBB"
        />
      </ServerContainer>
    </div>
  );
}

export default OSFPView;
