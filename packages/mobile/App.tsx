/**
 * App shell and flow orchestration.
 *
 * The flow is deliberately linear — job → container → VIN → verdict → job —
 * because a branching UI is the last thing an officer needs at a gate. Order
 * within a pair is not forced, though: real yards do not present the container
 * and the vehicle in a fixed sequence.
 */

import { useState, useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet, View, Text } from 'react-native';
import * as Location from 'expo-location';
import type { ReconResult } from '@dp/shared-rules';

import { LoginScreen } from './src/screens/LoginScreen.tsx';
import { JobScreen } from './src/screens/JobScreen.tsx';
import { ScanScreen, type CaptureResult } from './src/screens/ScanScreen.tsx';
import { VerdictScreen } from './src/screens/VerdictScreen.tsx';
import { commitCapture } from './src/lib/capture.ts';
import { startSyncLoop } from './src/lib/sync.ts';
import { clearTokens, type LoginResponse } from './src/lib/api.ts';
import { theme } from './src/components/theme.ts';

const APP_VERSION = '1.0.0';

type Stage =
  | { name: 'login' }
  | { name: 'job' }
  | { name: 'scan-container' }
  | { name: 'scan-vin'; container: CaptureResult }
  | { name: 'verdict'; result: ReconResult; containerNo: string; vin: string };

/**
 * A stable per-install identifier for device binding. Persisted alongside the
 * tokens, so a reinstall registers as a new device and needs re-approval —
 * which is the intended behaviour, not an inconvenience.
 */
function useDeviceId(): string {
  const ref = useRef<string>();
  if (!ref.current) {
    ref.current = `dev-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }
  return ref.current;
}

export default function App() {
  const deviceId = useDeviceId();
  const [session, setSession] = useState<LoginResponse | null>(null);
  const [stage, setStage] = useState<Stage>({ name: 'login' });
  const [busy, setBusy] = useState(false);

  const locationId = session?.locations[0]?.id ?? null;
  const locationName = session?.locations[0]?.name ?? 'Unassigned';

  // Ask for location once, after sign-in. It is evidence attached to each
  // scan, never a gate on capture.
  useEffect(() => {
    if (session) void Location.requestForegroundPermissionsAsync();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    return startSyncLoop(() => locationId, () => {});
  }, [session, locationId]);

  if (!session || stage.name === 'login') {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <LoginScreen
          deviceId={deviceId}
          onSignedIn={(next) => { setSession(next); setStage({ name: 'job' }); }}
        />
      </SafeAreaProvider>
    );
  }

  const signOut = async () => {
    await clearTokens();
    setSession(null);
    setStage({ name: 'login' });
  };

  const onVinCaptured = async (container: CaptureResult, vin: CaptureResult) => {
    if (!locationId) return;
    setBusy(true);
    try {
      const outcome = await commitCapture({
        locationId, appVersion: APP_VERSION, container, vin,
      });
      setStage({
        name: 'verdict',
        result: outcome.result,
        containerNo: container.value,
        vin: vin.value,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        {busy ? (
          <View style={styles.busy}><Text style={styles.busyText}>Reconciling…</Text></View>
        ) : stage.name === 'job' ? (
          <JobScreen
            locationId={locationId!}
            locationName={locationName}
            officerName={session.user.fullName}
            onStartScan={() => setStage({ name: 'scan-container' })}
            onSignOut={signOut}
          />
        ) : stage.name === 'scan-container' ? (
          <ScanScreen
            target="container"
            onCaptured={(container) => setStage({ name: 'scan-vin', container })}
            onCancel={() => setStage({ name: 'job' })}
          />
        ) : stage.name === 'scan-vin' ? (
          <ScanScreen
            target="vin"
            onCaptured={(vin) => void onVinCaptured(stage.container, vin)}
            onCancel={() => setStage({ name: 'scan-container' })}
          />
        ) : (
          <VerdictScreen
            result={stage.result}
            containerNo={stage.containerNo}
            vin={stage.vin}
            pendingUpload
            onNext={() => setStage({ name: 'scan-container' })}
            onDone={() => setStage({ name: 'job' })}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  busy: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  busyText: { color: theme.muted, fontSize: 17 },
});
