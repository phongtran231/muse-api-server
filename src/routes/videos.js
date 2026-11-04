'use strict';

/**
 * Video generation.
 *
 *   POST /v1/videos/generations
 *
 * Asynchronous by default (202 + job object) because rendering typically
 * takes minutes. Pass "async": false to wait up to SYNC_WAIT_MAX_MS.
 */

const express = require('express');
const { requireScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { methodNotAllowed } = require('../middleware/errorHandler');
const { serializeJob } = require('../serializers');
const { z, metadataSchema, referenceSchema, refsSchema, MAX_REFS } = require('./helpers');
const { submitGeneration } = require('./generation');

const router = express.Router();

const VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
const VIDEO_MODES = ['text_to_video', 'image_to_video', 'video_to_video'];
const referenceImageSchema = z.object({
  type: z.enum(['image', 'face']).default('image'),
  image: referenceSchema,
  weight: z.number().min(0).max(1).optional(),
  lock: z.boolean().optional()
}).strict();

const videoRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    model: z.string().max(64).optional(),
    mode: z.enum(VIDEO_MODES).optional(),
    aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).default('16:9'),
    duration: z.number().int().min(3).max(10).default(5),
    style: z.string().trim().max(500).optional(),
    negative_prompt: z.string().trim().max(1000).optional(),
    first_frame_image: referenceSchema.optional(),
    reference_images: z.array(referenceImageSchema).min(1).max(MAX_REFS).optional(),
    reference_image: referenceSchema.optional(),
    reference_video: referenceSchema.optional(),
    refs: refsSchema.optional(),
    async: z.boolean().default(true),
    webhook_url: z.string().max(2048).optional(),
    metadata: metadataSchema.optional()
  })
  .strict()
  .refine((b) => !((b.first_frame_image || b.reference_images || b.reference_image || b.refs) && b.reference_video), {
    message: 'Provide either reference images or reference_video, not both',
    path: ['reference_video']
  })
  .refine((b) => (b.first_frame_image ? 1 : 0) + (b.reference_images?.length || 0) + (b.reference_image ? 1 : 0) + (b.refs?.length || 0) <= MAX_REFS, {
    message: `At most ${MAX_REFS} reference images in total`,
    path: ['refs']
  })
  .refine((b) => !b.mode || b.mode !== 'image_to_video' || b.first_frame_image || b.reference_images?.length || b.reference_image || b.refs?.length, {
    message: 'image_to_video requires at least one reference image',
    path: ['first_frame_image']
  })
  .refine((b) => !b.mode || b.mode !== 'video_to_video' || b.reference_video, {
    message: 'video_to_video requires reference_video',
    path: ['reference_video']
  })
  .refine((b) => b.mode !== 'text_to_video' || !(b.first_frame_image || b.reference_images || b.reference_image || b.refs || b.reference_video), {
    message: 'text_to_video cannot be combined with reference media',
    path: ['mode']
  });

router
  .route('/generations')
  .post(requireScope('videos'), validate(videoRequestSchema), async (req, res) => {
    const body = req.valid.body;
    const referenceImages = [
      ...(body.first_frame_image ? [{ value: body.first_frame_image, param: 'first_frame_image', hint: { type: 'image', role: 'first_frame' } }] : []),
      ...(body.reference_images || []).map((item, index) => ({
        value: item.image,
        param: `reference_images[${index}].image`,
        hint: { type: item.type, ...(item.weight !== undefined ? { weight: item.weight } : {}), ...(item.lock !== undefined ? { lock: item.lock } : {}) }
      })),
      ...(body.reference_image ? [{ value: body.reference_image, param: 'reference_image', hint: { type: 'image' } }] : []),
      ...(body.refs || []).map((value, index) => ({ value, param: `refs[${index}]`, hint: { type: 'image' } }))
    ];
    await submitGeneration(req, res, {
      type: 'video',
      sync: body.async === false,
      params: {
        model: body.model || null,
        mode: body.mode || (referenceImages.length ? 'image_to_video' : body.reference_video ? 'video_to_video' : 'text_to_video'),
        aspect_ratio: body.aspect_ratio,
        duration: body.duration,
        style: body.style || null,
        negative_prompt: body.negative_prompt || null,
        reference_image_hints: referenceImages.map((item) => item.hint)
      },
      references: {
        images: referenceImages.map((item) => item.value),
        imageParams: referenceImages.map((item) => item.param),
        video: body.reference_video
      },
      onSucceeded: (job, response) => response.status(200).json(serializeJob(job))
    });
  })
  .all(methodNotAllowed(['POST']));

module.exports = router;
module.exports.VIDEO_ASPECT_RATIOS = VIDEO_ASPECT_RATIOS;
module.exports.VIDEO_MODES = VIDEO_MODES;
module.exports.videoRequestSchema = videoRequestSchema;
