/**
 * Loading checklist — the officer's primary screen.
 *
 * Replaces a linear scan-then-scan flow with the model the yard actually uses:
 * here are the cars for this box, tick them off. The container plate is
 * photographed once, then each chassis plate, and a row settles green only when
 * both reads are in and the pairing agrees with the pickup report.
 *
 * Why a checklist rather than a wizard: an officer loading four cars does not
 * want four trips through a flow, and a list makes what is still outstanding
 * visible without remembering it.
 */

import { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';

import { reconcile, normalizeVin, type PickupReportLine, type ReconResult } from '@dp/shared-rules';

import { theme } from '../components/theme.ts';
import type { CaptureResult } from './ScanScreen.tsx';

/** A chassis read that is not on this container's list. */
interface Intruder {
  vin: string;
  label: string;
  detail: string;
}

interface RowState {
  read: string;
  outcome: ReconResult['outcome'];
  detail: string;
}

interface Props {
  containerNo: string;
  /** Report lines for this container, from the cached report. */
  lines: PickupReportLine[];
  /** VINs already aboard, so a re-scan is caught as a duplicate. */
  loadedVins: Set<string>;
  reportValidTo?: Date;

  /** Opens the camera. Resolves with the confirmed read, or null if cancelled. */
  onCapture: (target: 'container' | 'vin') => Promise<CaptureResult | null>;
  /** Called once every expected vehicle is verified and the officer seals. */
  onSeal: (containerNo: string) => void;
  onBack: () => void;
}

export function ChecklistScreen({
  containerNo, lines, loadedVins, reportValidTo, onCapture, onSeal, onBack,
}: Props) {
  const [plate, setPlate] = useState<string | null>(null);
  const [rows, setRows] = useState<Map<string, RowState>>(new Map());
  const [intruders, setIntruders] = useState<Intruder[]>([]);
  const [busy, setBusy] = useState<null | 'container' | string>(null);

  const verified = useMemo(
    () => lines.filter((line) => rows.get(line.vin)?.outcome === 'MATCH').length,
    [lines, rows],
  );
  const complete = lines.length > 0 && verified === lines.length;
  const problems = intruders.length
    + [...rows.values()].filter((row) => row.outcome !== 'MATCH').length;

  /* ---------------- capture handlers ---------------- */

  const shootPlate = useCallback(async () => {
    if (busy || plate) return;
    setBusy('container');
    try {
      const result = await onCapture('container');
      // The officer confirmed the value on the camera screen, and the check
      // digit was validated there — nothing further to decide here.
      if (result) setPlate(result.value);
    } catch (error) {
      Alert.alert('Could not read the plate', error instanceof Error ? error.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  }, [busy, plate, onCapture]);

  const shootChassis = useCallback(async (expectedVin: string) => {
    if (busy || !plate) return;
    setBusy(expectedVin);
    try {
      const capture = await onCapture('vin');
      if (!capture) return;

      const read = normalizeVin(capture.value);

      const result = reconcile({
        containerNo: plate,
        vin: read,
        lines,
        loadedVins: new Set([
          ...loadedVins,
          ...[...rows.entries()].filter(([, r]) => r.outcome === 'MATCH').map(([vin]) => vin),
        ]),
        reportValidTo,
      });

      const onThisList = lines.some((line) => line.vin === read);

      if (onThisList) {
        setRows((previous) => {
          const next = new Map(previous);
          next.set(read, { read, outcome: result.outcome, detail: result.detail ?? '' });
          return next;
        });
      } else {
        // A car that is not on this container's list gets its own row rather
        // than overwriting the one the officer was aiming at — the expected
        // vehicle is still outstanding.
        setIntruders((previous) => [...previous, {
          vin: read,
          label: result.expectedLine
            ? [result.expectedLine.make, result.expectedLine.model].filter(Boolean).join(' ')
            : 'Not on this report',
          detail: result.detail ?? result.message,
        }]);
      }
    } finally {
      setBusy(null);
    }
  }, [busy, plate, lines, loadedVins, rows, reportValidTo, onCapture]);

  /* ---------------- rendering ---------------- */

  const Slot = ({ state, label, onPress, working }: {
    state: 'idle' | 'done' | 'bad';
    label: string;
    onPress?: () => void;
    working?: boolean;
  }) => (
    <Pressable
      style={[
        styles.slot,
        state === 'done' && styles.slotDone,
        state === 'bad' && styles.slotBad,
        !onPress && styles.slotInert,
      ]}
      onPress={onPress}
      disabled={!onPress || working}
      accessibilityRole="button"
      accessibilityLabel={state === 'done' ? `${label}, read and matched` : label}
    >
      {working
        ? <ActivityIndicator size="small" color={theme.warnText} />
        : <Text style={[
            styles.slotIcon,
            state === 'done' && styles.slotIconDone,
            state === 'bad' && styles.slotIconBad,
          ]}>{state === 'done' ? '✓' : state === 'bad' ? '✕' : '○'}</Text>}
      <Text style={[
        styles.slotText,
        state === 'done' && styles.slotTextDone,
        state === 'bad' && styles.slotTextBad,
      ]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.containerNo}>{containerNo}</Text>
            <Text style={styles.meta}>{verified} of {lines.length} verified</Text>
          </View>
          <Pressable onPress={onBack}><Text style={styles.link}>Back</Text></Pressable>
        </View>

        {/* The plate is photographed once; every row depends on it. */}
        <View style={styles.plateCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.plateTitle}>Container plate</Text>
            <Text style={styles.plateNote}>
              {plate ? 'Read and confirmed' : 'Photograph the number on the door'}
            </Text>
          </View>
          <Slot
            state={plate ? 'done' : 'idle'}
            label={plate ?? 'Take photo'}
            onPress={plate ? undefined : shootPlate}
            working={busy === 'container'}
          />
        </View>

        {problems > 0 && (
          <View style={[styles.banner, styles.bannerStop]}>
            <Text style={styles.bannerTitle}>
              {problems} {problems === 1 ? 'car needs' : 'cars need'} attention
            </Text>
            <Text style={styles.bannerBody}>
              Do not load them into {containerNo}. A supervisor has been notified.
            </Text>
          </View>
        )}

        {complete && problems === 0 && (
          <View style={[styles.banner, styles.bannerGo]}>
            <Text style={styles.bannerTitle}>Ready to seal</Text>
            <Text style={styles.bannerBody}>
              All {lines.length} cars verified against the pickup report.
            </Text>
          </View>
        )}

        {lines.map((line) => {
          const row = rows.get(line.vin);
          const settled = row?.outcome === 'MATCH';

          return (
            <View key={line.vin} style={[styles.row, settled && styles.rowSettled]}>
              <Text style={styles.pos}>{line.loadPosition ?? '—'}</Text>

              <View style={styles.about}>
                <Text style={styles.vehicle} numberOfLines={2}>
                  {[line.make, line.model, line.colour].filter(Boolean).join(' ')}
                </Text>
                <Text style={styles.vin}>{line.vin}</Text>

                <View style={styles.marks}>
                  <Slot state={plate ? 'done' : 'idle'} label="Container" />
                  <Slot
                    state={row ? (settled ? 'done' : 'bad') : 'idle'}
                    label={row ? row.read : 'Chassis photo'}
                    onPress={!row && plate ? () => void shootChassis(line.vin) : undefined}
                    working={busy === line.vin}
                  />
                </View>

                {row && !settled && row.detail
                  ? <Text style={styles.why}>{row.detail}</Text>
                  : null}
              </View>
            </View>
          );
        })}

        {intruders.map((intruder) => (
          <View key={intruder.vin} style={[styles.row, styles.rowWrong]}>
            <Text style={[styles.pos, styles.posWrong]}>!</Text>
            <View style={styles.about}>
              <Text style={styles.vehicle} numberOfLines={2}>{intruder.label}</Text>
              <Text style={styles.vin}>{intruder.vin}</Text>
              <View style={styles.marks}>
                <Slot state="done" label="Container" />
                <Slot state="bad" label={intruder.vin} />
              </View>
              <Text style={styles.why}>{intruder.detail}</Text>
            </View>
          </View>
        ))}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.sealButton, !complete && styles.sealDisabled]}
          onPress={() => onSeal(containerNo)}
          disabled={!complete}
        >
          <Text style={styles.sealText}>
            {complete ? 'Seal container' : `${lines.length - verified} still to verify`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 16, gap: 10 },

  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 4 },
  containerNo: {
    color: theme.text, fontSize: 22, fontWeight: '800',
    fontVariant: ['tabular-nums'], letterSpacing: 0.5,
  },
  meta: { color: theme.muted, fontSize: 14 },
  link: { color: theme.accent, fontSize: 16, padding: 4 },

  plateCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: theme.surface, borderRadius: 12, padding: 14, marginBottom: 4,
  },
  plateTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  plateNote: { color: theme.muted, fontSize: 13 },

  banner: { borderRadius: 10, padding: 14, gap: 3, marginBottom: 4 },
  bannerStop: { backgroundColor: theme.blockBg },
  bannerGo: { backgroundColor: theme.passBg },
  bannerTitle: { color: theme.text, fontSize: 15, fontWeight: '700' },
  bannerBody: { color: theme.text, fontSize: 13, lineHeight: 19 },

  row: {
    flexDirection: 'row', gap: 10, backgroundColor: theme.surface,
    borderRadius: 12, padding: 13, borderWidth: 1, borderColor: 'transparent',
  },
  rowSettled: { borderColor: theme.pass, backgroundColor: theme.passBg },
  rowWrong: { borderColor: theme.block, backgroundColor: theme.blockBg },
  pos: {
    color: theme.muted, fontSize: 14, fontWeight: '700',
    width: 20, textAlign: 'center', fontVariant: ['tabular-nums'],
  },
  posWrong: { color: theme.block },
  about: { flex: 1, gap: 4 },
  vehicle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  vin: { color: theme.muted, fontSize: 13, fontVariant: ['tabular-nums'] },

  marks: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  slot: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    borderWidth: 1.5, borderColor: theme.border, borderStyle: 'dashed',
    borderRadius: 9, paddingVertical: 9, paddingHorizontal: 11, minHeight: 42,
  },
  slotInert: { opacity: 1 },
  slotDone: { borderStyle: 'solid', borderColor: theme.pass, backgroundColor: theme.passBg },
  slotBad: { borderStyle: 'solid', borderColor: theme.block, backgroundColor: theme.blockBg },
  slotIcon: { color: theme.muted, fontSize: 13, fontWeight: '900' },
  slotIconDone: { color: theme.pass },
  slotIconBad: { color: theme.block },
  slotText: {
    color: theme.muted, fontSize: 13, fontWeight: '600',
    fontVariant: ['tabular-nums'], maxWidth: 170,
  },
  slotTextDone: { color: theme.pass },
  slotTextBad: { color: theme.block },

  why: { color: theme.block, fontSize: 13, lineHeight: 18, marginTop: 3 },

  footer: { padding: 16, paddingTop: 10 },
  sealButton: {
    backgroundColor: theme.accent, borderRadius: 12, padding: 17, alignItems: 'center',
  },
  sealDisabled: { backgroundColor: theme.surface },
  sealText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
