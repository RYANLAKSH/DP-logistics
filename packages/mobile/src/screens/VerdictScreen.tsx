/**
 * The verdict.
 *
 * This screen is the product. An officer glances at it for about a second
 * while a truck idles, so it has to be unmistakable at arm's length in
 * sunlight, and a FAIL has to say what is actually wrong — not just "error".
 *
 * The verdict is never conveyed by colour alone: every state pairs a colour
 * with a word and a glyph.
 */

import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import type { ReconResult } from '@dp/shared-rules';

import { theme } from '../components/theme.ts';

interface Props {
  result: ReconResult;
  containerNo: string;
  vin: string;
  /** True while the reconciliation is still queued for upload. */
  pendingUpload: boolean;
  onNext: () => void;
  onDone: () => void;
}

const GLYPH: Record<string, string> = {
  pass: '✓',
  block: '✕',
  warn: '!',
};

export function VerdictScreen({ result, containerNo, vin, pendingUpload, onNext, onDone }: Props) {
  const isPass = result.severity === 'pass';
  const tone = isPass
    ? { bg: theme.passBg, fg: theme.pass }
    : result.severity === 'warn'
      ? { bg: theme.warnBg, fg: theme.warnText }
      : { bg: theme.blockBg, fg: theme.block };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.banner, { backgroundColor: tone.bg, borderColor: tone.fg }]}>
          <Text style={[styles.glyph, { color: tone.fg }]}>
            {GLYPH[result.severity] ?? '?'}
          </Text>
          <Text style={[styles.verdict, { color: tone.fg }]}>
            {isPass ? 'LOAD' : 'DO NOT LOAD'}
          </Text>
          <Text style={styles.message}>{result.message}</Text>
        </View>

        {result.detail && <Text style={styles.detail}>{result.detail}</Text>}

        <View style={styles.card}>
          <Row label="Container" value={containerNo} />
          <Row label="VIN" value={vin} />
          {result.matchedLine && (
            <Row
              label="Vehicle"
              value={[result.matchedLine.make, result.matchedLine.model, result.matchedLine.colour]
                .filter(Boolean)
                .join(' ')}
            />
          )}
          {result.matchedLine?.loadPosition != null && (
            <Row label="Position" value={`#${result.matchedLine.loadPosition}`} />
          )}
          {result.expectedLine && (
            <Row label="Belongs in" value={result.expectedLine.containerNo} emphasis />
          )}
          {result.matchConfidence > 0 && result.matchConfidence < 1 && (
            <Row
              label="Match"
              value={`${(result.matchConfidence * 100).toFixed(0)}% — corrected read`}
              emphasis
            />
          )}
        </View>

        {result.progress && (
          <View style={styles.card}>
            <Text style={styles.progressText}>
              {result.progress.loaded} of {result.progress.expected} loaded
            </Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${(result.progress.loaded / Math.max(result.progress.expected, 1)) * 100}%`,
                  },
                ]}
              />
            </View>
            {result.progress.remainingVins.length > 0 && (
              <>
                <Text style={styles.remainingLabel}>Still expected</Text>
                {result.progress.remainingVins.map((remaining) => (
                  <Text key={remaining} style={styles.remainingVin}>{remaining}</Text>
                ))}
              </>
            )}
          </View>
        )}

        {pendingUpload && (
          <Text style={styles.queued}>
            Saved on device — will upload and notify when a connection is available.
          </Text>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <Pressable style={styles.primaryButton} onPress={onNext}>
          <Text style={styles.primaryButtonText}>
            {isPass ? 'Next vehicle' : 'Scan again'}
          </Text>
        </Pressable>
        <Pressable onPress={onDone}>
          <Text style={styles.link}>Back to job</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, emphasis && styles.rowValueEmphasis]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 16, gap: 14 },

  banner: { borderRadius: 16, borderWidth: 2, padding: 24, alignItems: 'center', gap: 6 },
  glyph: { fontSize: 56, fontWeight: '900', lineHeight: 62 },
  verdict: { fontSize: 34, fontWeight: '900', letterSpacing: 1 },
  message: { fontSize: 17, color: theme.text, textAlign: 'center', marginTop: 4 },

  detail: { fontSize: 16, color: theme.text, lineHeight: 23, paddingHorizontal: 4 },

  card: { backgroundColor: theme.surface, borderRadius: 12, padding: 16, gap: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  rowLabel: { color: theme.muted, fontSize: 14 },
  rowValue: {
    color: theme.text, fontSize: 16, fontWeight: '600',
    fontVariant: ['tabular-nums'], flexShrink: 1, textAlign: 'right',
  },
  rowValueEmphasis: { color: theme.warnText },

  progressText: { color: theme.text, fontSize: 16, fontWeight: '600' },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: theme.border, overflow: 'hidden' },
  progressFill: { height: 8, backgroundColor: theme.pass },
  remainingLabel: { color: theme.muted, fontSize: 13, marginTop: 4 },
  remainingVin: { color: theme.text, fontSize: 14, fontVariant: ['tabular-nums'] },

  queued: { color: theme.muted, fontSize: 14, textAlign: 'center', paddingHorizontal: 8 },

  actions: { padding: 16, gap: 4 },
  primaryButton: { backgroundColor: theme.accent, padding: 18, borderRadius: 12, alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  link: { color: theme.accent, fontSize: 16, textAlign: 'center', padding: 10 },
});
