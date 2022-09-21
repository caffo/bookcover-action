// DEPENDENCIES

const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const cheerio = require('cheerio');
const bookcovers = require("bookcovers");
const download = require('image-downloader');
const imagemagick = require('imagemagick-cli');

const sourceFile = path.join(process.env.GITHUB_WORKSPACE, 'out/Recently_ReadDatabase.html')

// ORCHESTRATION

loadSourceFile(sourceFile)
  .then(file => parseSourceFile(file))
  .then(dom => getBookEntries(dom))
  .then(entries => getBooksData(entries))
  .then(data => addExistentCovers(data))
  .then(data => getRemoteCovers(data))
  .then(data => buildNewMarkup((data)))
  .then(markup => updateSourceFile(markup))

// STEPS

async function loadSourceFile(file) {
  console.log("Started 'bookcover' action.")

  return fs.readFileSync(file, 'utf8');
}

async function parseSourceFile(file) {
  let dom = cheerio.load(file);
  global.$ = dom // needed for using cheerio features within several steps

  return dom
}

async function getBookEntries(dom) {
  return dom('li > h3 ~ ul > li:has(p:has(span:contains("bookcover:")))')
}

async function getBooksData(entries) {
  return entries.map(function () {
    return {
      node: $(this).attr('id'),
      isbn: $(this).children('p:has(span:contains("bookcover:"))').text().replace('bookcover: ', '').trim(),
      title: $(this).find('p:has(a) > a').first().text(),
      url: $(this).find('p:has(a) > a').first().attr('href'),
      comment: $(this).find('ul > li > ul > li > p').text(),
      cover: '',
    }
  }).toArray();
}

async function addExistentCovers(data) {
  return data.map(function(entry) {
    let file = path.join(process.env.GITHUB_WORKSPACE, `covers/${entry.isbn}.jpg`)

    if (fs.existsSync(file)) {
      entry.cover = file
    }

    return entry
  });
}

async function getRemoteCovers(data) {
  // find available covers
  const searchCovers = (isbn) => {
    return new Promise((resolve) => {
      bookcovers
        .withIsbn(isbn)
        .then(covers => {
          resolve(covers);
        });
    });
  }

  // pick best cover
  const pickBestCover = (covers) => {
    const qualityRank = [
      'openLibrary.large',
      "amazon['2x']",
      "amazon['1.5x']",
      'openLibrary.medium',
      "amazon.['1x']",
      'google.thumbnail',
      'google.smallThumbnail',
      'openLibrary.small'
    ]

    let cover = 'covers/default.jpg'

    qualityRank.some(function(source) {
      let sourceResult = _.get(covers, source, null)

      if (sourceResult) {
        cover = sourceResult;
        return true
      }
    })

    return cover
  }

  // download best cover
  const downloadBestCover = (isbn, cover) => {
    if (cover.includes('default.jpg')) {
      return cover
    } else {
      return new Promise((resolve) => {
        download.image({ url: cover, dest: path.join(process.env.GITHUB_WORKSPACE, `covers/${isbn}.jpg`) })
          .then(({ _filename }) => {
            resolve(`covers/${isbn}.jpg`)
          })
      })
    }
  }

  // transform cover
  const transformCover = (cover) => {
    if (cover.includes('default.jpg')) {
      return cover
    } else {
      return new Promise((resolve) => {
        let command = `magick ${path.join(process.env.GITHUB_WORKSPACE, cover)} -resize 100x157 -colorspace gray -ordered-dither o8x8 ${path.join(process.env.GITHUB_WORKSPACE, cover)}`;

        imagemagick.exec(command)
          .then(({ _stdout, stderr }) => {
            if (!stderr) {
              resolve(cover)
            }
          });
      })
    }
  }

  // add cover to data
  let promises = data.map(async function (entry) {
    if (entry.isbn && !entry.cover) {
      entry.cover = await searchCovers(entry.isbn)
                      .then(covers => pickBestCover(covers))
                      .then(cover => downloadBestCover(entry.isbn, cover))
                      .then(cover => transformCover(cover))
    } else if (!entry.isbn) {
      entry.cover = 'covers/default.jpg'
    }

    return entry
  })

  return await Promise.all(promises)
}

async function buildNewMarkup(data) {
  data.forEach(function (entry, i) {
      let node = $(`#${entry.node}`)

      let markup = `
        <li id='${entry.node}' style='display: inline;' lazy='loaded'>
          <div class='cover'>
            <img src='${entry.cover}' />
            
            <div class='tooltip'>
              <ul>
                <li>${entry.title}</li>
                <li>${entry.comment}</li>
              </ul>    
            </div>
          </div>
        </li>
      `;

      node.replaceWith(markup)
  });

  return $
}

async function updateSourceFile(markup) {
  fs.writeFileSync(path.join(process.env.GITHUB_WORKSPACE, 'out/Recently_ReadDatabase.html'), markup.html())

  console.log("Finished 'bookcover' action.")
}