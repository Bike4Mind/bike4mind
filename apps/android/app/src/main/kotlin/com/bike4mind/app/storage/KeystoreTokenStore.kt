package com.bike4mind.app.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import com.bike4mind.kit.auth.PendingRevocation
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
import org.json.JSONArray
import org.json.JSONObject

/**
 * The token pair, AES-GCM encrypted under a non-exportable Android Keystore key (the Android counterpart of
 * the iOS keychain item). A blob that no longer decrypts (key wiped, app restored elsewhere) reads as signed out.
 */
class KeystoreTokenStore(context: Context) : TokenStore {
    private val prefs = context.getSharedPreferences("b4m.tokens", Context.MODE_PRIVATE)

    override suspend fun load(): Tokens? = withContext(Dispatchers.IO) {
        val plain = open(BLOB) ?: return@withContext null
        runCatching { JSONObject(plain).let { Tokens(it.getString(ACCESS), it.getString(REFRESH)) } }.getOrElse {
            prefs.edit { remove(BLOB) }
            null
        }
    }

    override suspend fun save(tokens: Tokens) = withContext(Dispatchers.IO) {
        seal(BLOB, JSONObject().put(ACCESS, tokens.accessToken).put(REFRESH, tokens.refreshToken).toString())
    }

    override suspend fun clear() = withContext(Dispatchers.IO) {
        prefs.edit { remove(BLOB) }
    }

    override suspend fun loadPendingRevocations(): List<PendingRevocation> = withContext(Dispatchers.IO) {
        val array = open(PENDING)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return@withContext emptyList()
        (0 until array.length()).mapNotNull { index ->
            val item = array.optJSONObject(index) ?: return@mapNotNull null
            val baseUrl = item.optString(BASE_URL).ifEmpty { return@mapNotNull null }
            val refresh = item.optString(REFRESH).ifEmpty { return@mapNotNull null }
            PendingRevocation(baseUrl, refresh, item.optLong(CREATED_AT))
        }
    }

    override suspend fun savePendingRevocations(revocations: List<PendingRevocation>) = withContext(Dispatchers.IO) {
        if (revocations.isEmpty()) {
            prefs.edit { remove(PENDING) }
            return@withContext
        }
        val array = JSONArray()
        revocations.forEach {
            array.put(
                JSONObject().put(BASE_URL, it.baseUrl).put(REFRESH, it.refreshToken).put(CREATED_AT, it.createdAtMillis),
            )
        }
        seal(PENDING, array.toString())
    }

    /** The decrypted value under [name], or null; a blob that no longer decrypts is dropped. */
    private fun open(name: String): String? {
        val blob = prefs.getString(name, null) ?: return null
        return try {
            val bytes = Base64.decode(blob, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
            String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
        } catch (unreadable: GeneralSecurityException) {
            prefs.edit { remove(name) }
            null
        } catch (unreadable: IllegalArgumentException) {
            prefs.edit { remove(name) }
            null
        }
    }

    private fun seal(name: String, plain: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        prefs.edit { putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)) }
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
        const val PENDING = "pendingRevocations"
        const val BASE_URL = "baseUrl"
        const val CREATED_AT = "createdAt"
        const val ACCESS = "access"
        const val REFRESH = "refresh"
    }
}
