import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Container,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChrome,
  faDiscord,
} from '@fortawesome/free-brands-svg-icons';

import ResponsiveAppBar from '../components/ResponsiveAppBar';
import SubscriptionDialog from '../components/SubscriptionDialog';

const Home = () => {
  const [jobs, setJobs] = useState([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState('');

  useEffect(() => {
    document.title = 'Tutorica Forms | Home';
  }, []);

  useEffect(() => {
    let active = true;

    const loadJobs = async () => {
      try {
        const response = await fetch('/api/qa/jobs?limit=2', { method: 'GET' });
        const data = await response.json();

        if (!active) {
          return;
        }

        if (!response.ok) {
          const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
          throw new Error(message);
        }

        setJobs(Array.isArray(data.jobs) ? data.jobs : []);
        setJobsError('');
      } catch (error) {
        if (!active) {
          return;
        }

        setJobsError(error.message || 'No se pudo cargar el estado de jobs.');
      } finally {
        if (active) {
          setJobsLoading(false);
        }
      }
    };

    loadJobs();
    const timer = window.setInterval(loadJobs, 2500);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const activeJobs = useMemo(
    () => jobs.filter((job) => job.status === 'running' || job.status === 'queued'),
    [jobs]
  );

  const openNewTab = (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <>
      <ResponsiveAppBar />
      <Container maxWidth='lg' sx={{ py: { xs: 4, md: 6 } }}>
        <Paper
          elevation={0}
          sx={{
            borderRadius: 4,
            p: { xs: 3, md: 5 },
            border: '1px solid rgba(15, 23, 42, 0.12)',
            background:
              'radial-gradient(circle at top right, rgba(15, 118, 110, 0.18), transparent 48%), linear-gradient(165deg, #ffffff, #f4f7ff)',
          }}
        >
          <Stack spacing={3} alignItems='flex-start'>
            <Chip
              label='Google Forms QA Toolkit'
              sx={{ fontWeight: 700, borderRadius: 2, backgroundColor: '#d1fae5' }}
            />

            <Typography
              component='h1'
              sx={{
                fontFamily: '"Sora", "Trebuchet MS", sans-serif',
                fontSize: { xs: 32, md: 46 },
                fontWeight: 700,
                lineHeight: 1.1,
                color: '#0f172a',
              }}
            >
              Test your Google Forms faster, with controlled and repeatable runs.
            </Typography>

            <Typography sx={{ fontSize: 18, color: '#334155', maxWidth: 820 }}>
              Tutorica Forms helps you validate form behavior in development and QA environments by
              sending controlled submissions and showing progress in real time.
            </Typography>

            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              sx={{ width: '100%' }}
            >
              <Button
                variant='contained'
                startIcon={<FontAwesomeIcon icon={faChrome} />}
                onClick={() =>
                  openNewTab(
                    'https://chrome.google.com/webstore/detail/borang/mokcmggiibmlpblkcdnblmajnplennol'
                  )
                }
                sx={{
                  py: 1.2,
                  px: 2.2,
                  borderRadius: 2.5,
                  backgroundColor: '#0f766e',
                  '&:hover': { backgroundColor: '#0d9488' },
                }}
              >
                Install extension
              </Button>

              <Button
                variant='outlined'
                startIcon={<FontAwesomeIcon icon={faDiscord} />}
                onClick={() => openNewTab('https://discord.gg/rGkPJju9zD')}
                sx={{ py: 1.2, px: 2.2, borderRadius: 2.5 }}
              >
                Community support
              </Button>

              <SubscriptionDialog />
            </Stack>
          </Stack>
        </Paper>

        <Box
          sx={{
            mt: 3,
            p: { xs: 2.2, md: 3 },
            borderRadius: 3,
            border: '1px solid rgba(30, 41, 59, 0.12)',
            backgroundColor: '#ffffff',
          }}
        >
          <Typography variant='h6' sx={{ fontWeight: 700, color: '#0f172a', mb: 1.2 }}>
            Quick start
          </Typography>
          <Stack spacing={1} sx={{ color: '#334155', fontSize: 15 }}>
            <Box component='span'>1. Load the extension in your browser.</Box>
            <Box component='span'>2. Set backend URL and QA options in the popup.</Box>
            <Box component='span'>3. Open a Google Form and submit to start a QA run.</Box>
            <Box component='span'>4. Track progress from extension status and backend jobs API.</Box>
          </Stack>
        </Box>

        <Box
          sx={{
            mt: 3,
            p: { xs: 2.2, md: 3 },
            borderRadius: 3,
            border: '1px solid rgba(30, 41, 59, 0.12)',
            backgroundColor: '#ffffff',
          }}
        >
          <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 1 }}>
            <Typography variant='h6' sx={{ fontWeight: 700, color: '#0f172a' }}>
              Progreso de envios (backend)
            </Typography>
            <Chip
              label={activeJobs.length ? `${activeJobs.length} activos` : 'Sin jobs activos'}
              color={activeJobs.length ? 'warning' : 'success'}
              size='small'
            />
          </Stack>

          {jobsLoading && <Typography sx={{ color: '#475569' }}>Cargando estado...</Typography>}

          {!jobsLoading && jobsError && (
            <Typography sx={{ color: '#b91c1c' }}>Error: {jobsError}</Typography>
          )}

          {!jobsLoading && !jobsError && !jobs.length && (
            <Typography sx={{ color: '#475569' }}>No hay ejecuciones recientes.</Typography>
          )}

          {!jobsLoading && !jobsError && jobs.length > 0 && (
            <Stack spacing={1.2}>
              {jobs.map((job) => {
                const processed = Number(job.sent || 0) + Number(job.failed || 0);
                const total = Number(job.count || 0);
                const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
                const statusColor =
                  job.status === 'completed'
                    ? 'success'
                    : job.status === 'completed_with_errors'
                      ? 'error'
                      : job.status === 'running' || job.status === 'queued'
                        ? 'warning'
                        : 'default';
                const progressColor =
                  job.status === 'completed'
                    ? 'success'
                    : job.status === 'completed_with_errors'
                      ? 'error'
                      : 'primary';

                return (
                  <Box
                    key={job.id}
                    sx={{
                      border: '1px solid rgba(148, 163, 184, 0.4)',
                      borderRadius: 2,
                      p: 1.2,
                      backgroundColor: '#f8fafc',
                    }}
                  >
                    <Stack
                      direction={{ xs: 'column', md: 'row' }}
                      justifyContent='space-between'
                      alignItems={{ xs: 'flex-start', md: 'center' }}
                    >
                      <Typography sx={{ fontWeight: 700, color: '#1e293b' }}>
                        {String(job.label || 'Sin etiqueta').slice(0, 72)}
                      </Typography>
                      <Chip
                        size='small'
                        label={job.status}
                        color={statusColor}
                      />
                    </Stack>

                    <Typography sx={{ mt: 0.7, fontSize: 13, color: '#475569' }}>
                      {processed}/{total} procesados | enviados: {job.sent || 0} | fallidos: {job.failed || 0}
                    </Typography>
                    <LinearProgress
                      variant='determinate'
                      value={percent}
                      color={progressColor}
                      sx={{ mt: 0.9, height: 8, borderRadius: 999 }}
                    />
                  </Box>
                );
              })}
            </Stack>
          )}
        </Box>

        <Box sx={{ mt: 3 }}>
          <Box
            sx={{
              position: 'relative',
              width: '100%',
              overflow: 'hidden',
              borderRadius: 3,
              border: '1px solid rgba(30, 41, 59, 0.14)',
              pt: '56.25%',
              boxShadow: '0 16px 40px rgba(15, 23, 42, 0.12)',
            }}
          >
            <Box
              component='iframe'
              src='https://www.youtube.com/embed/W1pJxIIzZ_A?si=IYJ-jLQl-rCV_qkQ'
              title='Tutorica Forms tutorial video'
              sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
              allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen;'
              allowFullScreen
            />
          </Box>
        </Box>

      </Container>
    </>
  );
};

export default Home;
