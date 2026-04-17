import { useEffect } from 'react';
import { Box } from '@mui/material';
import ResponsiveAppBar from '../components/ResponsiveAppBar';

const Donate = () => {
  useEffect(() => {
    document.title = 'Tutorica Forms | Donate';
  }, []);

  return (
    <>
      <ResponsiveAppBar />
      <Box
        component='main'
        alignItems='center'
        justifyContent='center'
        display='flex'
        minHeight='90vh'
        flexDirection='column'
      >
        <h1>💗Thanks For the Donation💗</h1>
        <h2>
          We appreciate very much your contribution to this open source project
        </h2>
      </Box>
    </>
  );
};

export default Donate;
