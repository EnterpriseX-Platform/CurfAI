package com.enterprisex.curf.engine.application.secret;

/** Port: encryption of stored credentials. Plaintext never leaves the engine and is never logged. */
public interface SecretCipher {

    /** Ciphertext plus the id of the master key that wrapped it, so keys can be rotated. */
    record EncryptedSecret(String keyId, String ciphertext) {}

    EncryptedSecret encrypt(String plaintext);

    String decrypt(EncryptedSecret secret);

    /** True when the secret was wrapped by a key other than the current one. */
    boolean needsRotation(EncryptedSecret secret);
}
