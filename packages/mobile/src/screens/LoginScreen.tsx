import { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';

import { login, type LoginResponse } from '../lib/api.ts';
import { theme } from '../components/theme.ts';

const APP_VERSION = '1.0.0';

interface Props {
  deviceId: string;
  onSignedIn: (session: LoginResponse) => void;
}

export function LoginScreen({ deviceId, onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);

    const result = await login(email.trim(), password, deviceId, APP_VERSION);
    setBusy(false);

    if (!result.ok) {
      // Offline is a distinct failure from bad credentials, and the officer
      // needs to know which — one is their problem, the other is not.
      setError(
        result.offline
          ? 'No connection. You must be online to sign in the first time.'
          : result.message,
      );
      return;
    }
    onSignedIn(result.data);
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.brand}>DP Reconcile</Text>
        <Text style={styles.tagline}>Container and vehicle verification</Text>

        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor={theme.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
        />
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={theme.muted}
          secureTextEntry
          textContentType="password"
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, (busy || !email || !password) && styles.buttonDisabled]}
          onPress={submit}
          disabled={busy || !email || !password}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg, justifyContent: 'center' },
  inner: { padding: 24, gap: 14 },
  brand: { fontSize: 30, fontWeight: '800', color: theme.text },
  tagline: { fontSize: 16, color: theme.muted, marginBottom: 18 },
  input: {
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
    borderRadius: 12, padding: 16, fontSize: 17, color: theme.text,
  },
  error: { color: theme.block, fontSize: 15 },
  button: {
    backgroundColor: theme.accent, padding: 18, borderRadius: 12,
    alignItems: 'center', marginTop: 8,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
});
