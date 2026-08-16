/**
 * Capture screen: photograph a plate, read it, confirm it.
 *
 * Design constraints that shaped this, all of them from the yard rather than
 * the spec: the officer is standing in sun next to a running truck, wearing
 * gloves, and every extra tap costs adoption. So:
 *   - the shutter is large and always reachable with a thumb
 *   - a check-digit-valid container read auto-fills, needing one confirm tap
 *   - manual entry is a peer of scanning, not a buried fallback
 *   - the check digit validates as you type, before you can submit
 */

import { useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, TextInput, ActivityIndicator, Alert,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import {
  normalizeContainerNo, normalizeVin, isValidContainerNo, isPlausibleVin,
  isCheckDigitAmbiguous,
} from '@dp/shared-rules';

import { getOcrProvider, type ScanTarget, type OcrResult } from '../lib/ocr.ts';
import { theme } from '../components/theme.ts';

export interface CaptureResult {
  value: string;
  imageUri: string | null;
  ocr: OcrResult | null;
  wasManualEntry: boolean;
  checkDigitOk: boolean | null;
}

interface Props {
  target: ScanTarget;
  onCaptured: (result: CaptureResult) => void;
  onCancel: () => void;
}

const LABEL: Record<ScanTarget, { title: string; hint: string; placeholder: string }> = {
  container: {
    title: 'Scan container number',
    hint: 'Frame the number panel on the container door',
    placeholder: 'ABCU1234567',
  },
  vin: {
    title: 'Scan vehicle VIN',
    hint: 'Frame the label on the door pillar',
    placeholder: '17-character VIN',
  },
};

export function ScanScreen({ target, onCaptured, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);

  const [busy, setBusy] = useState(false);
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [manualMode, setManualMode] = useState(false);

  const label = LABEL[target];

  const validate = useCallback(
    (raw: string): { value: string; valid: boolean; note: string | null } => {
      if (target === 'container') {
        const value = normalizeContainerNo(raw);
        if (value.length !== 11) {
          return { value, valid: false, note: `${value.length}/11 characters` };
        }
        if (!isValidContainerNo(value)) {
          return { value, valid: false, note: 'Check digit does not match — re-read the plate' };
        }
        return {
          value,
          valid: true,
          note: isCheckDigitAmbiguous(value)
            ? 'Check digit valid, but this number ends in 0 — verify carefully'
            : 'Check digit valid',
        };
      }

      const value = normalizeVin(raw);
      if (value.length !== 17) {
        return { value, valid: false, note: `${value.length}/17 characters` };
      }
      if (!isPlausibleVin(value)) {
        return { value, valid: false, note: 'Contains characters not valid in a VIN' };
      }
      return { value, valid: true, note: '17 characters — confirm against the label' };
    },
    [target],
  );

  const capture = async () => {
    if (!camera.current || busy) return;
    setBusy(true);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.8, skipProcessing: true });
      if (!photo?.uri) throw new Error('Camera returned no image');

      setImageUri(photo.uri);
      const result = await getOcrProvider().recognize(photo.uri, target);
      setOcr(result);

      // Nothing usable — go straight to manual rather than making the officer
      // discover the fallback themselves.
      if (!result.value) {
        setManualMode(true);
        setManual('');
      } else {
        setManual(result.value);
      }
    } catch (error) {
      Alert.alert('Capture failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    const { value, valid } = validate(manual);
    if (!valid) return;

    onCaptured({
      value,
      imageUri,
      ocr,
      // Manual if the officer typed it, or edited what OCR proposed.
      wasManualEntry: manualMode || value !== ocr?.value,
      checkDigitOk: target === 'container' ? isValidContainerNo(value) : null,
    });
  };

  if (!permission) return <View style={styles.screen} />;

  if (!permission.granted) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.title}>Camera access needed</Text>
        <Text style={styles.hint}>
          The app photographs container plates and VIN labels as evidence for each
          reconciliation.
        </Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>Grant access</Text>
        </Pressable>
        <Pressable onPress={onCancel}><Text style={styles.link}>Cancel</Text></Pressable>
      </View>
    );
  }

  const check = validate(manual);
  const hasRead = Boolean(imageUri) || manualMode;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{label.title}</Text>
        <Text style={styles.hint}>{label.hint}</Text>
      </View>

      {!hasRead ? (
        <>
          <View style={styles.cameraWrap}>
            <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" />
            <View style={styles.guide} pointerEvents="none">
              <View style={[styles.guideBox, target === 'vin' && styles.guideBoxWide]} />
            </View>
          </View>

          <View style={styles.controls}>
            <Pressable style={styles.shutter} onPress={capture} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <View style={styles.shutterInner} />}
            </Pressable>
            <Pressable onPress={() => { setManualMode(true); setManual(''); }}>
              <Text style={styles.link}>Enter manually</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <View style={styles.reviewPane}>
          {ocr && ocr.candidates.length > 1 && (
            <View style={styles.warnBanner}>
              <Text style={styles.warnText}>
                More than one number in frame. Re-frame a single plate, or type the correct
                one below.
              </Text>
            </View>
          )}

          {ocr?.value && !manualMode && (
            <Text style={styles.readSource}>
              Read by {getOcrProvider().name}
              {ocr.exact ? '' : ' (corrected)'} · confidence {(ocr.confidence * 100).toFixed(0)}%
            </Text>
          )}

          <TextInput
            style={[styles.input, check.valid ? styles.inputValid : styles.inputInvalid]}
            value={manual}
            onChangeText={(text) =>
              setManual(target === 'container' ? normalizeContainerNo(text) : normalizeVin(text))
            }
            placeholder={label.placeholder}
            placeholderTextColor={theme.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            spellCheck={false}
            maxLength={target === 'container' ? 11 : 17}
          />

          {check.note && (
            <Text style={[styles.note, check.valid ? styles.noteOk : styles.noteBad]}>
              {check.note}
            </Text>
          )}

          <Pressable
            style={[styles.primaryButton, !check.valid && styles.buttonDisabled]}
            onPress={confirm}
            disabled={!check.valid}
          >
            <Text style={styles.primaryButtonText}>Confirm</Text>
          </Pressable>

          <Pressable
            onPress={() => { setImageUri(null); setOcr(null); setManualMode(false); setManual(''); }}
          >
            <Text style={styles.link}>Retake</Text>
          </Pressable>
        </View>
      )}

      <Pressable style={styles.cancel} onPress={onCancel}>
        <Text style={styles.link}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  header: { padding: 20, paddingBottom: 12 },
  title: { fontSize: 22, fontWeight: '700', color: theme.text },
  hint: { fontSize: 15, color: theme.muted, marginTop: 4 },

  cameraWrap: { flex: 1, margin: 16, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  guide: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  guideBox: {
    width: '82%', height: 96,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)', borderRadius: 10,
  },
  guideBoxWide: { height: 130 },

  controls: { alignItems: 'center', paddingBottom: 28, gap: 16 },
  shutter: {
    width: 84, height: 84, borderRadius: 42,
    backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: {
    width: 66, height: 66, borderRadius: 33,
    borderWidth: 4, borderColor: '#fff',
  },

  reviewPane: { flex: 1, padding: 20, gap: 14 },
  readSource: { fontSize: 13, color: theme.muted },
  input: {
    borderWidth: 2, borderRadius: 12, padding: 16,
    fontSize: 26, letterSpacing: 2, fontVariant: ['tabular-nums'],
    color: theme.text, backgroundColor: theme.surface,
  },
  inputValid: { borderColor: theme.pass },
  inputInvalid: { borderColor: theme.border },
  note: { fontSize: 14 },
  noteOk: { color: theme.pass },
  noteBad: { color: theme.muted },

  warnBanner: { backgroundColor: theme.warnBg, padding: 12, borderRadius: 10 },
  warnText: { color: theme.warnText, fontSize: 14 },

  primaryButton: {
    backgroundColor: theme.accent, padding: 18, borderRadius: 12, alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  buttonDisabled: { opacity: 0.4 },

  link: { color: theme.accent, fontSize: 16, textAlign: 'center', padding: 8 },
  cancel: { paddingBottom: 16 },
});
