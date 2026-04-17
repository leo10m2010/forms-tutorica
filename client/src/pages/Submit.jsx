import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
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
import { faCircleCheck, faMedal } from '@fortawesome/free-solid-svg-icons';

import ResponsiveAppBar from '../components/ResponsiveAppBar';
import SubscriptionDialog from '../components/SubscriptionDialog';
import { purple } from '@mui/material/colors';
import { deleteFormData, getFormData, getUser } from '../utils/api';
import { useUserStore } from '../stores/userStore';
import { submitFormFree, submitFormPremium } from '../utils/googleForm';

const Submit = () => {
  const [limit, setLimit] = useState(0);
  const [counter, setCounter] = useState(1);
  const [request, setRequest] = useState(0);
  const [isPremium, setIsPremium] = useState(null);

  const [isReady, userEmail, setBadges] = useUserStore((state) => [
    state.isReady,
    state.userEmail,
    state.setBadges,
  ]);

  const progressValue = useMemo(() => {
    if (!counter) {
      return 0;
    }

    return Math.min(100, Math.round((request / counter) * 100));
  }, [request, counter]);

  const isCompleted = counter > 0 && request >= counter;

  const urls = {
    extensionChromeStore:
      'https://chrome.google.com/webstore/detail/borang/mokcmggiibmlpblkcdnblmajnplennol',
    discord: 'https://discord.gg/rGkPJju9zD',
  };

  const openNewTab = (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  useEffect(() => {
    document.title = 'Tutorica Forms | Submit';
  }, []);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    (async () => {
      const formId = window.location.search.split('=')[1];
      if (!formId) {
        return;
      }

      const res = await getFormData(formId);
      if (!res) {
        return;
      }

      let speed = 50;
      let { limit: freeLimit, counter: requestedCount, formUrl, body } = res;
      let userData = { badges: [] };

      try {
        userData = await getUser(userEmail);
        if (!userData) {
          userData = { badges: [] };
        }

        setBadges(userData.badges || []);
        speed = userData.settings?.speed || 50;
      } catch (error) {
        console.error(error);
      }

      if (!userData.badges.includes('skrin-premium')) {
        setIsPremium(false);
        window._isPremium = false;
        requestedCount = requestedCount > freeLimit ? freeLimit : requestedCount;
        deleteFormData(formId);
      } else {
        setIsPremium(true);
        window._isPremium = true;
      }

      setLimit(freeLimit);
      setCounter(requestedCount);
      spamForm(requestedCount, formUrl, body, speed);
    })();
  }, [isReady]);

  const spamForm = async (count, formUrl, body, speed) => {
    const submitAction = window._isPremium ? submitFormPremium : submitFormFree;

    for (let i = 0; i < count; i++) {
      try {
        if (window._isPremium) {
          await submitAction(formUrl, body, speed);
        } else {
          await submitAction(formUrl, body);
        }
      } catch (error) {
        console.error(error);
      } finally {
        setRequest((prev) => prev + 1);
      }
    }
  };

  return (
    <>
      <ResponsiveAppBar />
      <Container maxWidth='md' sx={{ py: { xs: 4, md: 5 } }}>
        {!isReady ? (
          <Stack alignItems='center' spacing={2} sx={{ mt: 6 }}>
            <CircularProgress />
            <Typography sx={{ color: '#475569' }}>Preparing your QA run...</Typography>
          </Stack>
        ) : (
          <Stack spacing={2.5}>
            <Paper
              elevation={0}
              sx={{
                p: { xs: 2.5, md: 3 },
                borderRadius: 3,
                border: '1px solid rgba(15, 23, 42, 0.12)',
                background:
                  'radial-gradient(circle at top right, rgba(15, 118, 110, 0.14), transparent 42%), #ffffff',
              }}
            >
              <Stack spacing={2}>
                <Stack direction='row' justifyContent='space-between' alignItems='center'>
                  <Typography variant='h4' sx={{ fontWeight: 700, color: '#0f172a' }}>
                    QA Submission Progress
                  </Typography>

                  {isCompleted ? (
                    <Chip
                      icon={<FontAwesomeIcon icon={faCircleCheck} />}
                      label='Completed'
                      color='success'
                      sx={{ fontWeight: 700 }}
                    />
                  ) : (
                    <Chip label='Running' color='warning' sx={{ fontWeight: 700 }} />
                  )}
                </Stack>

                <Typography sx={{ color: '#334155' }}>
                  This page tracks your current bulk submission request in real time.
                </Typography>

                <Box>
                  <LinearProgress
                    variant='determinate'
                    value={progressValue}
                    sx={{ height: 12, borderRadius: 999 }}
                  />
                  <Typography sx={{ mt: 1, color: '#1e293b', fontWeight: 600 }}>
                    {request} / {counter} requests processed ({progressValue}%)
                  </Typography>
                </Box>
              </Stack>
            </Paper>

            <Paper
              elevation={0}
              sx={{
                p: { xs: 2.5, md: 3 },
                borderRadius: 3,
                border: '1px solid rgba(15, 23, 42, 0.12)',
                backgroundColor: '#ffffff',
              }}
            >
              <Stack spacing={1.2}>
                <Typography variant='h6' sx={{ fontWeight: 700 }}>
                  Plan status
                </Typography>

                {isPremium ? (
                  <Stack direction='row' spacing={1.2} alignItems='center'>
                    <Chip
                      label='Skrin Premium'
                      sx={{
                        color: '#ffffff',
                        backgroundColor: purple[400],
                        fontWeight: 700,
                      }}
                    />
                    <FontAwesomeIcon icon={faMedal} style={{ color: purple[400] }} />
                    <Typography sx={{ color: '#475569' }}>
                      Unlimited count and faster submission speed enabled.
                    </Typography>
                  </Stack>
                ) : (
                  <Stack spacing={0.8}>
                    <Typography sx={{ color: '#475569' }}>
                      Free mode applies limits to avoid accidental heavy traffic.
                    </Typography>
                    <Typography sx={{ color: '#0f172a', fontWeight: 600 }}>
                      Current free limit: {limit} submissions.
                    </Typography>
                    <Box>
                      <SubscriptionDialog />
                    </Box>
                  </Stack>
                )}
              </Stack>
            </Paper>

            <Paper
              elevation={0}
              sx={{
                p: { xs: 2.5, md: 3 },
                borderRadius: 3,
                border: '1px solid rgba(15, 23, 42, 0.12)',
                backgroundColor: '#ffffff',
              }}
            >
              <Typography variant='h6' sx={{ fontWeight: 700, mb: 1.2 }}>
                Useful links
              </Typography>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2}>
                <Button
                  variant='outlined'
                  startIcon={<FontAwesomeIcon icon={faChrome} />}
                  onClick={() => openNewTab(urls.extensionChromeStore)}
                  sx={{ borderRadius: 2.2 }}
                >
                  Rate extension
                </Button>
                <Button
                  variant='outlined'
                  startIcon={<FontAwesomeIcon icon={faDiscord} />}
                  onClick={() => openNewTab(urls.discord)}
                  sx={{ borderRadius: 2.2 }}
                >
                  Join Discord
                </Button>
              </Stack>
            </Paper>
          </Stack>
        )}
      </Container>
    </>
  );
};

export default Submit;
