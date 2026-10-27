package com.simplysync.kotlin

import java.net.URLClassLoader
import java.util.Base64
import java.util.Random
import org.junit.Assert.*
import org.junit.Test

class Base64UrlTest {
    @Test fun codecWorksWithoutJavaUtilBase64OnOlderAndroid() {
        val locations = arrayOf(Base64Url::class.java.protectionDomain.codeSource.location,
            Unit::class.java.protectionDomain.codeSource.location)
        val loader = object : URLClassLoader(locations, ClassLoader.getPlatformClassLoader()) {
            override fun loadClass(name: String, resolve: Boolean): Class<*> {
                if (name == "java.util.Base64" || name.startsWith("java.util.Base64$")) {
                    throw ClassNotFoundException("Base64 is unavailable on Android API 24–25")
                }
                return super.loadClass(name, resolve)
            }
        }
        loader.use {
            val codec = it.loadClass("com.simplysync.kotlin.Base64Url")
            val instance = codec.getField("INSTANCE").get(null)
            assertEquals("Zg", codec.getMethod("encode", ByteArray::class.java).invoke(instance, byteArrayOf(102)))
            assertArrayEquals(byteArrayOf(102), codec.getMethod("decode", String::class.java).invoke(instance, "Zg") as ByteArray)
        }
    }

    @Test fun everyByteAndAllShortLengthsMatchTheExistingWireEncoder() {
        val random = Random(98451)
        val inputs = listOf(ByteArray(256) { it.toByte() }) + (0..512).map { size ->
            ByteArray(size).also(random::nextBytes)
        }
        for (input in inputs) {
            val expected = Base64.getUrlEncoder().withoutPadding().encodeToString(input)
            assertEquals(expected, Base64Url.encode(input))
            assertArrayEquals(input, Base64Url.decode(expected))
            assertArrayEquals(input, Base64Url.decode(Base64.getEncoder().encodeToString(input)))
        }
    }

    @Test fun permissivePaddingAndMalformedInputsKeepTheExistingDecoderContract() {
        fun oracle(value: String): ByteArray? = try {
            Base64.getUrlDecoder().decode(value.replace('+', '-').replace('/', '_').replace("=", ""))
        } catch (_: IllegalArgumentException) { null }
        val explicit = listOf("", "=", "====", "Zg", "Zg==", "Z=g=", "Zh", "abc", "a", "abcde",
            "+/8=", "-_8", "Z g", "Zg\n", "\u0100", "\u00ff", "\ud83d\ude00")
        for (input in explicit) assertArrayEquals(input, oracle(input), Base64Url.decode(input))
        val random = Random(12875)
        for (length in 0..64) repeat(128) {
            val input = buildString { repeat(length) { append(random.nextInt(128).toChar()) } }
            assertArrayEquals(input, oracle(input), Base64Url.decode(input))
        }
    }
}
