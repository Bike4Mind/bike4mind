package com.bike4mind.app.media

import android.graphics.Bitmap
import android.graphics.Color
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.media.MediaItem
import com.bike4mind.kit.media.MediaKind
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpStatusCode
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MediaImageLoaderTest {
    private val environment = ServerEnvironment.Custom("https://test.example")
    private val root: File = Files.createTempDirectory("tiles").toFile()
    private val requests = mutableListOf<HttpRequestData>()

    private fun png(width: Int = 8, height: Int = 8, color: Int = Color.RED): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private fun loader(body: suspend () -> ByteArray = { png() }) = MediaImageLoader(
        HttpClient(MockEngine { request -> requests += request; respond(body(), HttpStatusCode.OK) }),
        root,
        environment,
    )

    private fun item(id: String = "a1", url: String? = "https://storage.test/a1?sig=1") =
        MediaItem(id, MediaKind.IMAGE, "a.png", "image/png", Instant.EPOCH, url = url)

    private fun tiles() = File(root, environment.host).listFiles().orEmpty().filter { it.name.endsWith(".tile") }

    @Test
    fun aTileIsKeptOnDiskForTheNextLoaderWithoutTheNetwork() = runTest {
        assertNotNull(loader().thumbnail(item()))
        assertEquals(1, tiles().size)

        // A fresh loader has an empty memory tier, and the item has no URL, so only the disk can answer.
        assertNotNull(loader().thumbnail(item(url = null)))
        assertEquals(1, requests.size)
    }

    @Test
    fun clearEmptiesBothTiers() = runTest {
        val images = loader()
        images.thumbnail(item())
        images.clear()

        assertTrue(tiles().isEmpty())
        assertNull(images.thumbnail(item(url = null)))
    }

    @Test
    fun aTileInFlightAtSignOutIsNotCached() = runTest {
        val downloading = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val images = loader {
            downloading.complete(Unit)
            release.await()
            png()
        }

        val load = async { images.thumbnail(item()) }
        downloading.await()
        images.clear()
        release.complete(Unit)
        load.await()

        assertTrue(tiles().isEmpty())
        assertNull(images.thumbnail(item(url = null)))
    }

    @Test
    fun aTransparentTileKeepsItsAlphaOnDisk() = runTest {
        loader { png(color = Color.TRANSPARENT) }.thumbnail(item())

        val cached = loader().thumbnail(item(url = null))
        assertNotNull(cached)
        assertEquals(0, Color.alpha(cached!!.getPixel(0, 0)))
    }

    @Test
    fun anOpaqueTileIsCachedAsJpegEvenWhenItsPngHasAnAlphaChannel() = runTest {
        // An ARGB PNG with every pixel opaque, as most generated images are.
        loader { png(color = Color.RED) }.thumbnail(item())

        assertEquals(listOf(0xFF, 0xD8), tiles().single().readBytes().take(2).map { it.toInt() and 0xFF })

        val cached = loader().thumbnail(item(url = null))!!
        val pixel = cached.getPixel(0, 0)
        assertEquals(255, Color.alpha(pixel))
        assertTrue(Color.red(pixel) > 200 && Color.green(pixel) < 60 && Color.blue(pixel) < 60)
    }

    @Test
    fun aSemiTransparentPixelIsEnoughToKeepThePng() = runTest {
        val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).apply {
            eraseColor(Color.RED)
            setPixel(0, 0, Color.argb(254, 255, 0, 0))
        }
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        loader { bytes }.thumbnail(item())

        assertEquals(listOf(0x89, 0x50), tiles().single().readBytes().take(2).map { it.toInt() and 0xFF })
    }

    @Test
    fun oneTransparentPixelIsEnoughToKeepThePng() = runTest {
        val bitmap = Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888).apply {
            eraseColor(Color.RED)
            setPixel(7, 7, Color.TRANSPARENT)
        }
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        loader { bytes }.thumbnail(item())

        assertEquals(listOf(0x89, 0x50), tiles().single().readBytes().take(2).map { it.toInt() and 0xFF })
    }

    @Test
    fun anIdThatIsNotPlainIsNeverWrittenToDisk() = runTest {
        loader().thumbnail(item(id = "../escape"))
        assertTrue(tiles().isEmpty())
    }

    @Test
    fun sampleSizeKeepsBothSidesAtLeastTheTarget() {
        assertEquals(1, MediaImageLoader.sampleSize(384, 384, 384))
        assertEquals(2, MediaImageLoader.sampleSize(1024, 768, 384))
        assertEquals(4, MediaImageLoader.sampleSize(4000, 3000, 384))
    }

    @Test
    fun sampleSizeCapsTheDecodeOfAVeryWideImage() {
        // The short side alone would allow full size; the pixel budget (8 x 384 x 384) forces a coarser step.
        val sample = MediaImageLoader.sampleSize(20_000, 400, 384)
        assertTrue((20_000L / sample) * (400 / sample) <= 8L * 384 * 384)
    }
}
