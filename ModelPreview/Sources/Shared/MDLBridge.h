#ifndef MDL_BRIDGE_H
#define MDL_BRIDGE_H

#import <SceneKit/SceneKit.h>
#import <SceneKit/ModelIO.h>
#include <stdlib.h>
#include <string.h>
#include "zstd/zstd.h"

// 字节序列搜索（BSD memmem 封装），返回偏移或 -1
static inline long FindBytes(const void *hay, size_t hayLen,
                             const void *needle, size_t needleLen, size_t from) {
    if (needleLen == 0 || from + needleLen > hayLen) return -1;
    const void *r = memmem((const char *)hay + from, hayLen - from, needle, needleLen);
    return r ? (long)((const char *)r - (const char *)hay) : -1;
}

// SceneKit 在新 SDK 中不再为 ModelIO 互转 API 提供 Swift 初始化器桥接，
// 通过 C 内联函数显式调用 ObjC 类工厂方法。
static inline SCNNode *MakeSCNNodeFromMDLObject(MDLObject *obj) {
    return [SCNNode nodeWithMDLObject:obj];
}

// zstd 多 frame 连续解压：Blender 5.x 将 .blend 分成多个连续 zstd frame。
// 返回 malloc 缓冲（调用方负责 free）。
static inline unsigned char *ZstdDecompressAll(const void *src, size_t srcSize, size_t *outSize) {
    size_t cap = 1 << 22;
    unsigned char *buf = (unsigned char *)malloc(cap);
    if (!buf) return NULL;
    size_t outTotal = 0;
    ZSTD_inBuffer in = { src, srcSize, 0 };
    while (in.pos < in.size) {
        size_t inBefore = in.pos;
        ZSTD_DStream *zs = ZSTD_createDStream();
        if (!zs) { free(buf); return NULL; }
        ZSTD_initDStream(zs);
        for (;;) {
            if (outTotal == cap) {
                cap *= 2;
                unsigned char *nb = (unsigned char *)realloc(buf, cap);
                if (!nb) { free(buf); ZSTD_freeDStream(zs); return NULL; }
                buf = nb;
            }
            ZSTD_outBuffer out = { buf + outTotal, cap - outTotal, 0 };
            size_t r = ZSTD_decompressStream(zs, &out, &in);
            if (ZSTD_isError(r)) { free(buf); ZSTD_freeDStream(zs); return NULL; }
            outTotal += out.pos;
            if (r == 0) break;             // 当前 frame 完成
        }
        ZSTD_freeDStream(zs);
        if (in.pos == inBefore) break;     // 防死循环：无进展
    }
    *outSize = outTotal;
    return buf;
}

#endif
