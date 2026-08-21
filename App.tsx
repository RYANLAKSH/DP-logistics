/**
 * App shell.
 *
 * Flow: sign in → the yard (containers) → one container's checklist → camera.
 *
 * The checklist is the centre of gravity, not a wizard. It asks for a photo
 * when it needs one, and the camera is a modal step that hands a confirmed
 * reading back — which is why onCapture is promise-shaped rather than a
 * navigation event. That keeps the checklist ignorant of navigation and lets it
 * stay a plain, testable component.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet, View, Text } from 'react-native';
import * as Location from 'expo-location';

import type { PickupReportLine } from '@dp/shared-rules';

import { LoginScreen } from './src/screens/LoginScreen.tsx';
import { JobScreen } from './src/screens/JobScreen.tsx';
import { ChecklistScreen } from './src/screens/ChecklistScreen.tsx';
import { ScanScreen, type CaptureResult } from './src/screens/ScanScreen.tsx';
import { commitCapture } from './src/lib/capture.ts';
import { startSyncLoop } from './src/lib/sync.ts';
import { getCachedLines, getCachedReport, getLoadedVins } from './src/lib/store.ts';
import { clearTokens, type LoginResponse } from './src/lib/api.ts';
import { theme } from './src/components/theme.ts';

const APP_VERSION = '1.0.0';

type Stage =
  | { name: 'login' }
  | { name: 'yard' }
  | { name: 'checklist'; containerNo: string };

/**
 * Stable per-install identifier for device binding. A reinstall registers as a
 * new device and needs supervisor approval again, which is intended.
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

  const [lines, setLines] = useState<PickupReportLine[]>([]);
  const [loadedVins, setLoadedVins] = useState<Set<string>>(new Set());
  const [validTo, setValidTo] = useState<Date | undefined>();

  /* The camera is a modal over whatever asked for it. */
  const [capturing, setCapturing] = useState<'container' | 'vin' | null>(null);
  const pending = useRef<((result: CaptureResult | null) => void) | null>(null);

  /* The container plate photo, reused for every chassis in that container. */
  const containerCapture = useRef<CaptureResult | null>(null);

  const locationId = session?.locations[0]?.id ?? null;
  const locationName = session?.locations[0]?.name ?? 'Unassigned';

  useEffect(() => {
    if (session) void Location.requestForegroundPermissionsAsync();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    return startSyncLoop(() => locationId, () => { void refresh(); });
  }, [session, locationId]);

  const refresh = useCallback(async () => {
    const [cachedLines, loaded, report] = await Promise.all([
      getCachedLines(), getLoadedVins(), getCachedReport(),
    ]);
    setLines(cachedLines);
    setLoadedVins(loaded);
    setValidTo(report ? new Date(`${report.validTo}T23:59:59.999Z`) : undefined);
  }, []);

  useEffect(() => { if (session) void refresh(); }, [session, refresh]);

  /** Opens the camera and resolves with what the officer confirmed. */
  const capture = useCallback((target: 'container' | 'vin') =>
    new Promise<CaptureResult | null>((resolve) => {
      pending.current = resolve;
      setCapturing(target);
    }), []);

  const finishCapture = useCallback((result: CaptureResult | null) => {
    const resolve = pending.current;
    pending.current = null;
    setCapturing(null);
    resolve?.(result);
  }, []);

  /**
   * Records one chassis read against the container plate already photographed.
   *
   * The checklist has computed a verdict for the officer's benefit; this is what
   * actually persists it and queues it for the server, which recomputes it
   * authoritatively.
   */
  const record = useCallback(async (vinCapture: CaptureResult) => {
    if (!locationId || !containerCapture.current) return;
    await commitCapture({
      locationId,
      appVersion: APP_VERSION,
      container: containerCapture.current,
      vin: vinCapture,
    });
    await refresh();
  }, [locationId, refresh]);

  const onCapture = useCallback(async (target: 'container' | 'vin') => {
    const result = await capture(target);
    if (!result) return null;

    if (target === 'container') containerCapture.current = result;
    else await record(result);

    return result;
  }, [capture, record]);

  const checklistLines = useMemo(
    () => stage.name === 'checklist'
      ? lines.filter((line) => line.containerNo === stage.containerNo)
      : [],
    [stage, lines],
  );

  if (!session || stage.name === 'login') {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <LoginScreen
          deviceId={deviceId}
          onSignedIn={(next) => { setSession(next); setStage({ name: 'yard' }); }}
        />
      </SafeAreaProvider>
    );
  }

  const signOut = async () => {
    await clearTokens();
    setSession(null);
    setStage({ name: 'login' });
  };

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        {capturing ? (
          <ScanScreen
            target={capturing}
            onCaptured={(result) => finishCapture(result)}
            onCancel={() => finishCapture(null)}
          />
        ) : stage.name === 'yard' ? (
          <JobScreen
            locationId={locationId!}
            locationName={locationName}
            officerName={session.user.fullName}
            onOpenContainer={(containerNo) => {
              // A different container means a different plate photo.
              containerCapture.current = null;
              setStage({ name: 'checklist', containerNo });
            }}
            onSignOut={signOut}
          />
        ) : checklistLines.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No vehicles cached for {stage.containerNo}. Pull to refresh on the yard screen.
            </Text>
          </View>
        ) : (
          <ChecklistScreen
            containerNo={stage.containerNo}
            lines={checklistLines}
            loadedVins={loadedVins}
            reportValidTo={validTo}
            onCapture={onCapture}
            onSeal={() => { void refresh(); setStage({ name: 'yard' }); }}
            onBack={() => setStage({ name: 'yard' })}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: theme.muted, fontSize: 16, textAlign: 'center' },
});
