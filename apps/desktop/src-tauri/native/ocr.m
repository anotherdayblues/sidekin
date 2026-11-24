#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// On-device text recognition with Apple Vision. Returns UTF-8 JSON:
//   {"ok":true,"lines":[{"t":"text","x":0.1,"y":0.2,"w":0.3,"h":0.04}, ...]}
//   {"ok":false,"error":"..."}
// Boxes are normalized to the image with a TOP-left origin (Vision's own
// origin is bottom-left, so y is flipped here). Order is left to the caller.
//
// Only the accurate model reads Chinese. The fast model silently turns
// unsupported scripts into Latin garbage (see TRex OCREngine
// validateFastRecognitionLanguages), so a failure is retried once with a
// fresh request and handler and otherwise reported, never sent to fast.

static NSArray<VNRecognizedTextObservation *> *
companion_recognize(NSData *data, NSError **error) API_AVAILABLE(macos(10.15)) {
  VNImageRequestHandler *handler =
      [[VNImageRequestHandler alloc] initWithData:data options:@{}];
  if (!handler)
    return nil;
  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = YES;
  // Small text in a large capture must not be dropped.
  request.minimumTextHeight = 0.0;
  if (@available(macOS 13.0, *)) {
    request.automaticallyDetectsLanguage = YES;
  }
  request.recognitionLanguages =
      @[ @"zh-Hans", @"zh-Hant", @"en-US", @"ja-JP", @"ko-KR" ];
  if (![handler performRequests:@[ request ] error:error])
    return nil;
  return request.results ?: @[];
}

static char *companion_json(NSDictionary *object) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:object
                                                 options:0
                                                   error:nil];
  if (!json)
    return strdup("{\"ok\":false,\"error\":\"encode\"}");
  char *out = malloc(json.length + 1);
  if (!out)
    return NULL;
  memcpy(out, json.bytes, json.length);
  out[json.length] = 0;
  return out;
}

char *companion_ocr_png(const uint8_t *bytes, size_t len) {
  @autoreleasepool {
    if (@available(macOS 10.15, *)) {
      if (!bytes || len == 0)
        return companion_json(@{@"ok" : @YES, @"lines" : @[]});
      NSData *data = [NSData dataWithBytes:bytes length:len];
      NSError *error = nil;
      NSArray<VNRecognizedTextObservation *> *results =
          companion_recognize(data, &error);
      if (!results) {
        error = nil;
        results = companion_recognize(data, &error);
      }
      if (!results) {
        NSString *reason = error.localizedDescription ?: @"recognize";
        return companion_json(@{@"ok" : @NO, @"error" : reason});
      }
      NSMutableArray *lines = [NSMutableArray array];
      for (VNRecognizedTextObservation *obs in results) {
        VNRecognizedText *top = [[obs topCandidates:1] firstObject];
        NSString *text = [top.string
            stringByTrimmingCharactersInSet:NSCharacterSet
                                                .whitespaceAndNewlineCharacterSet];
        if (!text.length)
          continue;
        CGRect r = obs.boundingBox;
        [lines addObject:@{
          @"t" : text,
          @"x" : @(r.origin.x),
          @"y" : @(1.0 - r.origin.y - r.size.height),
          @"w" : @(r.size.width),
          @"h" : @(r.size.height),
        }];
      }
      return companion_json(@{@"ok" : @YES, @"lines" : lines});
    }
    return companion_json(@{@"ok" : @NO, @"error" : @"macOS 10.15+"});
  }
}
