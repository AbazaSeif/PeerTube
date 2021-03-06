import { truncate } from 'lodash'
import { CONSTRAINTS_FIELDS, VIDEO_CATEGORIES } from '../initializers/constants'
import { logger } from './logger'
import { generateVideoImportTmpPath } from './utils'
import { join } from 'path'
import { root } from './core-utils'
import { ensureDir, writeFile, remove } from 'fs-extra'
import * as request from 'request'
import { createWriteStream } from 'fs'

export type YoutubeDLInfo = {
  name?: string
  description?: string
  category?: number
  licence?: number
  nsfw?: boolean
  tags?: string[]
  thumbnailUrl?: string
  originallyPublishedAt?: Date
}

const processOptions = {
  maxBuffer: 1024 * 1024 * 10 // 10MB
}

function getYoutubeDLInfo (url: string, opts?: string[]): Promise<YoutubeDLInfo> {
  return new Promise<YoutubeDLInfo>(async (res, rej) => {
    const args = opts || [ '-j', '--flat-playlist' ]

    const youtubeDL = await safeGetYoutubeDL()
    youtubeDL.getInfo(url, args, processOptions, (err, info) => {
      if (err) return rej(err)
      if (info.is_live === true) return rej(new Error('Cannot download a live streaming.'))

      const obj = buildVideoInfo(normalizeObject(info))
      if (obj.name && obj.name.length < CONSTRAINTS_FIELDS.VIDEOS.NAME.min) obj.name += ' video'

      return res(obj)
    })
  })
}

function downloadYoutubeDLVideo (url: string, timeout: number) {
  const path = generateVideoImportTmpPath(url)
  let timer

  logger.info('Importing youtubeDL video %s', url)

  const options = [ '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best', '-o', path ]

  if (process.env.FFMPEG_PATH) {
    options.push('--ffmpeg-location')
    options.push(process.env.FFMPEG_PATH)
  }

  return new Promise<string>(async (res, rej) => {
    const youtubeDL = await safeGetYoutubeDL()
    youtubeDL.exec(url, options, processOptions, err => {
      clearTimeout(timer)

      if (err) {
        remove(path)
          .catch(err => logger.error('Cannot delete path on YoutubeDL error.', { err }))

        return rej(err)
      }

      return res(path)
    })

    timer = setTimeout(async () => {
      await remove(path)

      return rej(new Error('YoutubeDL download timeout.'))
    }, timeout)
  })
}

// Thanks: https://github.com/przemyslawpluta/node-youtube-dl/blob/master/lib/downloader.js
// We rewrote it to avoid sync calls
async function updateYoutubeDLBinary () {
  logger.info('Updating youtubeDL binary.')

  const binDirectory = join(root(), 'node_modules', 'youtube-dl', 'bin')
  const bin = join(binDirectory, 'youtube-dl')
  const detailsPath = join(binDirectory, 'details')
  const url = 'https://yt-dl.org/downloads/latest/youtube-dl'

  await ensureDir(binDirectory)

  return new Promise(res => {
    request.get(url, { followRedirect: false }, (err, result) => {
      if (err) {
        logger.error('Cannot update youtube-dl.', { err })
        return res()
      }

      if (result.statusCode !== 302) {
        logger.error('youtube-dl update error: did not get redirect for the latest version link. Status %d', result.statusCode)
        return res()
      }

      const url = result.headers.location
      const downloadFile = request.get(url)
      const newVersion = /yt-dl\.org\/downloads\/(\d{4}\.\d\d\.\d\d(\.\d)?)\/youtube-dl/.exec(url)[ 1 ]

      downloadFile.on('response', result => {
        if (result.statusCode !== 200) {
          logger.error('Cannot update youtube-dl: new version response is not 200, it\'s %d.', result.statusCode)
          return res()
        }

        downloadFile.pipe(createWriteStream(bin, { mode: 493 }))
      })

      downloadFile.on('error', err => {
        logger.error('youtube-dl update error.', { err })
        return res()
      })

      downloadFile.on('end', () => {
        const details = JSON.stringify({ version: newVersion, path: bin, exec: 'youtube-dl' })
        writeFile(detailsPath, details, { encoding: 'utf8' }, err => {
          if (err) {
            logger.error('youtube-dl update error: cannot write details.', { err })
            return res()
          }

          logger.info('youtube-dl updated to version %s.', newVersion)
          return res()
        })
      })
    })
  })
}

async function safeGetYoutubeDL () {
  let youtubeDL

  try {
    youtubeDL = require('youtube-dl')
  } catch (e) {
    // Download binary
    await updateYoutubeDLBinary()
    youtubeDL = require('youtube-dl')
  }

  return youtubeDL
}

function buildOriginallyPublishedAt (obj: any) {
  let originallyPublishedAt: Date = null

  const uploadDateMatcher = /^(\d{4})(\d{2})(\d{2})$/.exec(obj.upload_date)
  if (uploadDateMatcher) {
    originallyPublishedAt = new Date()
    originallyPublishedAt.setHours(0, 0, 0, 0)

    const year = parseInt(uploadDateMatcher[1], 10)
    // Month starts from 0
    const month = parseInt(uploadDateMatcher[2], 10) - 1
    const day = parseInt(uploadDateMatcher[3], 10)

    originallyPublishedAt.setFullYear(year, month, day)
  }

  return originallyPublishedAt
}

// ---------------------------------------------------------------------------

export {
  updateYoutubeDLBinary,
  downloadYoutubeDLVideo,
  getYoutubeDLInfo,
  safeGetYoutubeDL,
  buildOriginallyPublishedAt
}

// ---------------------------------------------------------------------------

function normalizeObject (obj: any) {
  const newObj: any = {}

  for (const key of Object.keys(obj)) {
    // Deprecated key
    if (key === 'resolution') continue

    const value = obj[key]

    if (typeof value === 'string') {
      newObj[key] = value.normalize()
    } else {
      newObj[key] = value
    }
  }

  return newObj
}

function buildVideoInfo (obj: any) {
  return {
    name: titleTruncation(obj.title),
    description: descriptionTruncation(obj.description),
    category: getCategory(obj.categories),
    licence: getLicence(obj.license),
    nsfw: isNSFW(obj),
    tags: getTags(obj.tags),
    thumbnailUrl: obj.thumbnail || undefined,
    originallyPublishedAt: buildOriginallyPublishedAt(obj)
  }
}

function titleTruncation (title: string) {
  return truncate(title, {
    'length': CONSTRAINTS_FIELDS.VIDEOS.NAME.max,
    'separator': /,? +/,
    'omission': ' […]'
  })
}

function descriptionTruncation (description: string) {
  if (!description || description.length < CONSTRAINTS_FIELDS.VIDEOS.DESCRIPTION.min) return undefined

  return truncate(description, {
    'length': CONSTRAINTS_FIELDS.VIDEOS.DESCRIPTION.max,
    'separator': /,? +/,
    'omission': ' […]'
  })
}

function isNSFW (info: any) {
  return info.age_limit && info.age_limit >= 16
}

function getTags (tags: any) {
  if (Array.isArray(tags) === false) return []

  return tags
    .filter(t => t.length < CONSTRAINTS_FIELDS.VIDEOS.TAG.max && t.length > CONSTRAINTS_FIELDS.VIDEOS.TAG.min)
    .map(t => t.normalize())
    .slice(0, 5)
}

function getLicence (licence: string) {
  if (!licence) return undefined

  if (licence.indexOf('Creative Commons Attribution') !== -1) return 1

  return undefined
}

function getCategory (categories: string[]) {
  if (!categories) return undefined

  const categoryString = categories[0]
  if (!categoryString || typeof categoryString !== 'string') return undefined

  if (categoryString === 'News & Politics') return 11

  for (const key of Object.keys(VIDEO_CATEGORIES)) {
    const category = VIDEO_CATEGORIES[key]
    if (categoryString.toLowerCase() === category.toLowerCase()) return parseInt(key, 10)
  }

  return undefined
}
