import { useState, useEffect } from 'react';
import { getServer } from '../services/api';

export function useServerData(serverId = 'server-1', refreshKey = 0) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let isMounted = true;

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);
        const serverData = await getServer(serverId);

        if (isMounted) {
          setData(serverData);
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchData();

    return () => {
      isMounted = false;
    };
  }, [serverId, refreshKey]);

  return { data, loading, error };
}
