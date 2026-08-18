/**
 * Job screen — the officer's home base between scans.
 *
 * Shows what report is cached, how stale it is, what is still outstanding, and
 * how many results are waiting to upload. Connectivity state is stated plainly
 * rather than hidden, because an officer working offline needs to know that is
 * what is happening.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, RefreshControl,
} from 'react-native';

import type { PickupReportLine } from '@dp/shared-rules';

import { theme } from '../components/theme.ts';
import {
  getCachedReport, getCachedLines, getLoadedVins, pendingCount, imageQueueStats,
  type CachedReport,
} from '../lib/store.ts';
import { runSync } from '../lib/sync.ts';

interface Props {
  locationId: string;
  locationName: string;
  officerName: string;
  onStartScan: () => void;
  onSignOut: () => void;
}

interface ContainerProgress {
  containerNo: string;
  loaded: number;
  expected: number;
}

export function JobScreen({ locationId, locationName, officerName, onStartScan, onSignOut }: Props) {
  const [report, setReport] = useState<CachedReport | null>(null);
  const [containers, setContainers] = useState<ContainerProgress[]>([]);
  const [pending, setPending] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [disagreements, setDisagreements] = useState(0);
  const [images, setImages] = useState({ pending: 0, failed: 0 });

  const load = useCallback(async () => {
    const [cached, lines, loaded, queued, imageStats] = await Promise.all([
      getCachedReport(), getCachedLines(), getLoadedVins(), pendingCount(), imageQueueStats(),
    ]);

    setReport(cached);
    setPending(queued);
    setImages(imageStats);
    setContainers(summarize(lines, loaded));
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sync = useCallback(async () => {
    setRefreshing(true);
    const outcome = await runSync(locationId);
    setOffline(outcome.offline);
    setDisagreements(outcome.disagreements.length);
    await load();
    setRefreshing(false);
  }, [locationId, load]);

  useEffect(() => { void sync(); }, [sync]);

  const totalLoaded = containers.reduce((sum, entry) => sum + entry.loaded, 0);
  const totalExpected = containers.reduce((sum, entry) => sum + entry.expected, 0);

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={sync} tintColor={theme.muted} />}
      >
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.location}>{locationName}</Text>
            <Text style={styles.officer}>{officerName}</Text>
          </View>
          <Pressable onPress={onSignOut}><Text style={styles.link}>Sign out</Text></Pressable>
        </View>

        {offline && (
          <View style={[styles.banner, styles.bannerWarn]}>
            <Text style={styles.bannerText}>
              Working offline. Scans are saved on the device and will upload automatically.
            </Text>
          </View>
        )}

        {disagreements > 0 && (
          <View style={[styles.banner, styles.bannerAlert]}>
            <Text style={styles.bannerText}>
              {disagreements} earlier {disagreements === 1 ? 'verdict was' : 'verdicts were'} revised
              by the server after the report changed. A supervisor has been notified.
            </Text>
          </View>
        )}

        {report ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{report.referenceNo}</Text>
            <Text style={styles.cardMeta}>
              Version {report.version} · valid to {report.validTo}
            </Text>
            <Text style={styles.cardMeta}>
              Cached {formatAge(report.syncedAt)} · {totalLoaded} of {totalExpected} vehicles loaded
            </Text>
          </View>
        ) : (
          <View style={[styles.banner, styles.bannerAlert]}>
            <Text style={styles.bannerText}>
              No pickup report cached for this location. Connect and pull to refresh before
              scanning.
            </Text>
          </View>
        )}

        {containers.map((entry) => {
          const complete = entry.loaded === entry.expected;
          return (
            <View key={entry.containerNo} style={styles.containerRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.containerNo}>{entry.containerNo}</Text>
                <View style={styles.track}>
                  <View
                    style={[
                      styles.fill,
                      { width: `${(entry.loaded / entry.expected) * 100}%` },
                      complete && styles.fillDone,
                    ]}
                  />
                </View>
              </View>
              <Text style={[styles.count, complete && styles.countDone]}>
                {complete ? 'sealed' : `${entry.loaded}/${entry.expected}`}
              </Text>
            </View>
          );
        })}

        {pending > 0 && (
          <Text style={styles.pending}>
            {pending} {pending === 1 ? 'result' : 'results'} waiting to upload
          </Text>
        )}

        {images.pending > 0 && (
          <Text style={styles.pending}>
            {images.pending} {images.pending === 1 ? 'photo' : 'photos'} waiting to upload
          </Text>
        )}

        {images.failed > 0 && (
          <View style={[styles.banner, styles.bannerAlert]}>
            <Text style={styles.bannerText}>
              {images.failed} {images.failed === 1 ? 'photo could' : 'photos could'} not be
              uploaded after repeated attempts. Those reconciliations have no picture behind
              them — tell your supervisor.
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable
          style={[styles.primaryButton, !report && styles.buttonDisabled]}
          onPress={onStartScan}
          disabled={!report}
        >
          <Text style={styles.primaryButtonText}>Scan next vehicle</Text>
        </Pressable>
      </View>
    </View>
  );
}

function summarize(lines: PickupReportLine[], loaded: Set<string>): ContainerProgress[] {
  const map = new Map<string, ContainerProgress>();

  for (const line of lines) {
    const entry = map.get(line.containerNo) ?? {
      containerNo: line.containerNo, loaded: 0, expected: 0,
    };
    entry.expected++;
    if (loaded.has(line.vin)) entry.loaded++;
    map.set(line.containerNo, entry);
  }

  // Containers in progress first — that is what the officer is working on.
  return [...map.values()].sort((a, b) => {
    const aDone = a.loaded === a.expected ? 1 : 0;
    const bDone = b.loaded === b.expected ? 1 : 0;
    return aDone - bDone || a.containerNo.localeCompare(b.containerNo);
  });
}

function formatAge(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 16, gap: 12 },

  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  location: { fontSize: 24, fontWeight: '800', color: theme.text },
  officer: { fontSize: 15, color: theme.muted },
  link: { color: theme.accent, fontSize: 15, padding: 4 },

  banner: { borderRadius: 10, padding: 14 },
  bannerWarn: { backgroundColor: theme.warnBg },
  bannerAlert: { backgroundColor: theme.blockBg },
  bannerText: { color: theme.text, fontSize: 14, lineHeight: 20 },

  card: { backgroundColor: theme.surface, borderRadius: 12, padding: 16, gap: 4 },
  cardTitle: { color: theme.text, fontSize: 17, fontWeight: '700' },
  cardMeta: { color: theme.muted, fontSize: 14 },

  containerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: theme.surface, borderRadius: 12, padding: 14,
  },
  containerNo: {
    color: theme.text, fontSize: 16, fontWeight: '600',
    fontVariant: ['tabular-nums'], marginBottom: 8,
  },
  track: { height: 6, borderRadius: 3, backgroundColor: theme.border, overflow: 'hidden' },
  fill: { height: 6, backgroundColor: theme.accent },
  fillDone: { backgroundColor: theme.pass },
  count: { color: theme.muted, fontSize: 15, fontWeight: '600', minWidth: 52, textAlign: 'right' },
  countDone: { color: theme.pass },

  pending: { color: theme.muted, fontSize: 14, textAlign: 'center', paddingTop: 4 },

  actions: { padding: 16 },
  primaryButton: { backgroundColor: theme.accent, padding: 18, borderRadius: 12, alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  buttonDisabled: { opacity: 0.4 },
});
