package com.bike4mind.app.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import com.bike4mind.kit.auth.TokenStore
import com.bike4mind.kit.auth.Tokens
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject

/**
 * The token pair, AES-GCM encrypted under a non-exportable Android Keystore key (the Android counterpart of
 * the iOS keychain item). A blob that no longer decrypts (key wiped, app restored elsewhere) reads as signed out.
 */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs = context.getSharedPreferences("b4m.tokens", Context.MODE_PRIVATE)

    override suspend fun load(): Tokens? = withContext(Dispatchers.IO) {
        val blob = prefs.getString(BLOB, null) ?: return@withContext null
        try {
            val bytes = Base64.decode(blob, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
            val json = JSONObject(String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8))
            Tokens(json.getString(ACCESS), json.getString(REFRESH))
        } catch (unreadable: GeneralSecurityException) {
            prefs.edit { remove(BLOB) }
            null
        } catch (unreadable: JSONException) {
            prefs.edit { remove(BLOB) }
            null
        } catch (unreadable: IllegalArgumentException) {
            prefs.edit { remove(BLOB) }
            null
        }
    }

    override suspend fun save(tokens: Tokens) = withContext(Dispatchers.IO) {
        val plain = JSONObject().put(ACCESS, tokens.accessToken).put(REFRESH, tokens.refreshToken).toString()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        prefs.edit { putString(BLOB, Base64.encodeToString(sealed, Base64.NO_WRAP)) }
    }

    override suspend fun clear() = withContext(Dispatchers.IO) {
        prefs.edit { remove(BLOB) }
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "b4m.tokens.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        const val BLOB = "blob"
        const val ACCESS = "access"
        const val REFRESH = "refresh"
    }
}
