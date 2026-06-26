import { useNavigate, useParams } from 'react-router-dom';
import { useState, useEffect } from 'react';
import ServerContainer from '../components/ServerContainer/ServerContainer';
import PCIePort from '../components/PCIePorts/PCIePort';
import BackButton from '../components/common/BackButton';
import { getPCIePorts, getServer } from '../services/api';

function PCIeView() {
  const navigate = useNavigate();
  const { osfpId } = useParams();
  const [server, setServer] = useState(null);
  const [ports, setPorts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [serverData, portsData] = await Promise.all([
          getServer('server-1'),
          getPCIePorts('server-1', osfpId)
        ]);
        setServer(serverData);
        setPorts(portsData);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [osfpId]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '50px' }}>
        <p>Loading PCIe ports...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '50px', color: '#e74c3c' }}>
        <p>Error loading PCIe ports: {error}</p>
      </div>
    );
  }

  const handleBackClick = () => {
    navigate('/gbb/gbb-1');
  };

  return (
    <div>
      {server && <h1>{server.name} SN: {server.serialNumber}</h1>}
      <ServerContainer>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '10px'
        }}>
          {ports.map((port) => (
            <PCIePort
              key={port.id}
              id={port.id}
              name={port.name}
              status={port.status}
            />
          ))}
        </div>
        <BackButton
          onClick={handleBackClick}
          label="← Back to OSFP"
        />
      </ServerContainer>
    </div>
  );
}

export default PCIeView;
