export const toContentUri = async (protocol, hash) => {
    const utf8 = [protocol, hash].join(':')
    const contentURI = '0x' + Buffer.from(utf8, 'utf8').toString('hex')
    return contentURI
  }