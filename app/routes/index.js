const express = require('express')
const formidable = require('formidable')

const {
  getLastTokenId,
  getItem,
  runProcess,
  processMetadata,
  getFile,
  validateTokenIds,
  getReadableMetadataKeys,
  getItemMetadataSingle,
} = require('../util/appUtil')
const logger = require('../logger')
const { LEGACY_METADATA_KEY } = require('../env')

const router = express.Router()

router.get('/last-token', async (req, res) => {
  try {
    const result = await getLastTokenId()
    res.status(200).json({ id: result })
  } catch (err) {
    logger.error(`Error getting latest token. Error was ${err.message || JSON.stringify(err)}`)
    if (!res.headersSent) {
      res.status(500).send(`Error getting latest token`)
    }
  }
})

router.get('/item/:id', async (req, res) => {
  try {
    const id = req.params && parseInt(req.params.id, 10)
    if (Number.isInteger(id) && id !== 0) {
      const result = await getItem(id)

      result.metadata = getReadableMetadataKeys(result.metadata)

      if (result.id === id) {
        res.status(200).json(result)
      } else {
        res.status(404).json({
          message: `Id not found: ${id}`,
        })
      }
    } else {
      res.status(400).json({
        message: `Invalid id: ${id}`,
      })
    }
  } catch (err) {
    logger.error(`Error token. Error was ${err.message || JSON.stringify(err)}`)
    if (!res.headersSent) {
      res.status(500).send(`Error getting token`)
    }
  }
})

const getMetadataResponse = async (id, metadataKey, res) => {
  if (!Number.isInteger(id) || id === 0) {
    logger.trace(`Invalid id: ${id}`)
    res.status(400).json({ message: `Invalid id: ${id}` })
    return
  }

  let metadataValue
  try {
    metadataValue = await getItemMetadataSingle(id, metadataKey)
  } catch (err) {
    logger.trace(`Invalid metadata request: ${err.message}`)
    res.status(404).json({ message: err.message })
    return
  }

  if (metadataValue.file) {
    let file
    try {
      file = await getFile(metadataValue.file)
    } catch (err) {
      logger.warn(`Error fetching metadata file: ${metadataValue.file}. Error was ${err}`)
      res.status(500).send(`Error fetching metadata file: ${metadataValue.file}`)
      return
    }

    await new Promise((resolve, reject) => {
      res.status(200)
      res.set({
        immutable: true,
        maxAge: 365 * 24 * 60 * 60 * 1000,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      })
      file.file.pipe(res)
      file.file.on('error', (err) => reject(err))
      res.on('finish', () => resolve())
    })
    return
  }

  if (metadataValue.literal) {
    const readable = Buffer.from(metadataValue.literal.slice(2), 'hex').toString('utf8').replace(/\0/g, '')
    res.status(200).json(readable)
    return
  }

  if ('none' in metadataValue) {
    res.status(200).json({})
    return
  }

  logger.warn(`Error fetching metadata: ${metadataKey}:${metadataValue}`)
  res.status(500).send(`Error fetching metadata`)
  return
}

// legacy route, gets metadata with legacy key
router.get('/item/:id/metadata', async (req, res) => {
  const id = req.params && parseInt(req.params.id, 10)
  getMetadataResponse(id, LEGACY_METADATA_KEY, res)
})

router.get('/item/:id/metadata/:metadataKey', async (req, res) => {
  const id = req.params.id && parseInt(req.params.id, 10)
  getMetadataResponse(id, req.params.metadataKey, res)
})

router.post('/run-process', async (req, res) => {
  const form = formidable({ multiples: true })

  form.parse(req, async (formError, fields, files) => {
    try {
      if (formError) {
        logger.error(`Error processing form ${formError}`)
        res.status(500).json({ message: 'Unexpected error processing input' })
        return
      }

      let request = null
      try {
        request = JSON.parse(fields.request)
      } catch (parseError) {
        logger.trace(`Invalid user input ${parseError}`)
        res.status(400).json({ message: `Invalid user input ${parseError}` })
        return
      }

      if (!request || !request.inputs || !request.outputs) {
        logger.trace(`Request missing input and/or outputs`)
        res.status(400).json({ message: `Request missing input and/or outputs` })
        return
      }

      const inputsValid = await validateTokenIds(request.inputs)
      if (!inputsValid) {
        logger.trace(`Some inputs were invalid`)
        res.status(400).json({ message: `Some inputs were invalid: ${JSON.stringify(request.inputs)}` })
        return
      }

      const outputs = await Promise.all(
        request.outputs.map(async (output) => {
          //catch legacy single metadataFile
          if (output.metadataFile) {
            output.metadata = { [LEGACY_METADATA_KEY]: { type: 'FILE', value: output.metadataFile } }
          }
          try {
            return {
              owner: output.owner,
              metadata: await processMetadata(output.metadata, files),
            }
          } catch (err) {
            logger.trace(`Invalid metadata: ${err.message}`)
            res.status(400).json({ message: err.message })
            return
          }
        })
      )
      const result = await runProcess(request.inputs, outputs)

      if (result) {
        res.status(200).json(result)
      } else {
        logger.error(`Unexpected error running process ${result}`)
        res.status(500).json({
          message: `Unexpected error processing items`,
        })
      }
    } catch (err) {
      logger.error(`Error running process. Error was ${err.message || JSON.stringify(err)}`)
      if (!res.headersSent) {
        res.status(500).send(`Error running process`)
      }
    }
  })
})

module.exports = router
