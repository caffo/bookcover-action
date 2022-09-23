// DEPENDENCIES

const fs = require('fs');
const _ = require('lodash');
const path = require('path');
const cheerio = require('cheerio');
const bookcovers = require("bookcovers");
const download = require('image-downloader');
const imagemagick = require('imagemagick-cli');
const { execSync } = require('node:child_process');

// PREPARATION

const basePath = process.env.GITHUB_WORKSPACE || __dirname
const sourceFiles = execSync("git grep -Frl --untracked 'bookcover:' 'out/*.html'", { encoding: 'utf8'} )
                      .trim()
                      .split('\n')

// ORCHESTRATION

async function run() {
  for (const file of sourceFiles) {
    console.log('\n')
    console.log('- - - - - - - - - - - - - - - - - - - - - - - - -')
    console.log(`Processing ${file}`)

    await loadSourceFile(file)
      .then(file => parseSourceFile(file))
      .then(dom => getBookEntries(dom))
      .then(entries => getBooksData(entries))
      .then(data => addExistentCovers(data))
      .then(data => getRemoteCovers(data))
      .then(data => buildNewMarkup((data)))
      .then(markup => updateSourceFile(file, markup))

    console.log('- - - - - - - - - - - - - - - - - - - - - - - - -')
    console.log('\n')
  }
}

run();

// STEPS

async function loadSourceFile(file) {
  console.log("   step: load source file")

  return fs.readFileSync(path.join(basePath, file), 'utf8');
}

async function parseSourceFile(file) {
  console.log("   step: parse source file")

  let dom = cheerio.load(file);
  global.$ = dom // needed for using cheerio features within several steps

  return dom
}

async function getBookEntries(dom) {
  console.log("   step: find book entries")

  return dom('span:contains("bookcover:")').closest('li')
}

async function getBooksData(entries) {
  console.log("   step: extract book entries data")

  return entries.map(function () {
    return {
      node: $(this).attr('id'),
      isbn: $(this).children('p:has(span:contains("bookcover:"))').text().replace('bookcover: ', '').trim(),
      title: $(this).find('p:has(a)').first().html(),
      comment: $(this).find('ul > li > ul > li > p').html(),
      cover: '',
    }
  }).toArray();
}

async function addExistentCovers(data) {
  console.log("   step: check existent book covers")

  return data.map(function(entry) {
    let fileName = `covers/${entry.isbn}.jpg`
    let file = path.join(basePath, fileName)

    if (fs.existsSync(file)) {
      entry.cover = fileName
    }

    return entry
  });
}

async function getRemoteCovers(data) {
  console.log("   step: get missing book covers")

  // find available covers
  const searchCovers = (isbn) => {
    return new Promise((resolve) => {
      setTimeout(function(){
        bookcovers
          .withIsbn(isbn)
          .then(covers => {
            resolve(covers);
          });
      }, 1000)
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
        download.image({ url: cover, dest: path.join(basePath, `covers/${isbn}.jpg`) })
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
        let command = `magick ${path.join(basePath, cover)} -resize 100x157 -colorspace gray -ordered-dither o8x8 ${path.join(basePath, cover)}`;

        imagemagick.exec(command)
          .then(({ _stdout, stderr }) => {
            if (!stderr) {
              resolve(cover)
            } else {
              console.log(stderr)
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
  console.log("   step: build new html markup")

  data.forEach(function (entry, i) {
      let node = $(`#${entry.node}`)

      let markup = `
        <li id='${entry.node}' style='display: inline;' lazy='loaded'>
          <div class='cover'>
            <img src='${entry.cover}' />
            
            <div class='tooltip'>
              <ul>
                ${entry.title ? `<li>${entry.title}</li>` : ''}
                ${entry.comment ? `<li>${entry.comment}</li>` : ''}
              </ul>    
            </div>
          </div>
        </li>
      `;

      node.replaceWith(markup)
  });

  return $
}

async function updateSourceFile(file, markup) {
  console.log("   step: update source file")

  let css = `
    <style>
      .cover {
        padding:  0px !important;
        margin:  0px !important;
        width: fit-content;
        display: inline-flex !important;
        margin-right: 10px !important;
        cursor: pointer;
      }
      
      .cover img {
        width: 100px;
        height: 157px;
        margin: 0px !important;
        padding: 0px !important;
        border: 1px solid var(--divider-color);
        border-radius: 5px;
        filter: drop-shadow(0 2px 8px rgba(0,0,0,.11));
        -webkit-filter: drop-shadow(0 2px 8px rgba(0,0,0,.11));
        -webkit-transition: all .2s ease-in-out;
        transition: all .2s ease-in-out;
      }
      
      .cover img:hover  {
        -webkit-transform: scale(1.07);
        transform: scale(1.07);
      }
      
      
      /* tooltips  */
      .cover > .tooltip {
        display: none;
        position: relative;
      }
      
      /* Tooltip Hover CSS Begin */
      .cover > .tooltip > ul{
        margin: 0px;
        padding: 0px;
        padding-left: 10px;
      }
      
      .cover > .tooltip > ul > li {
          line-height: 20px;
          text-align: left;
      }
      
      .cover > .tooltip > ul > li:first-child{
        font-weight: bold;
        font-size: 22px;
      }
      
      .cover:hover > .tooltip {
        display: block;
        margin-top: -50px;
        position: absolute;
        z-index: 1;
        margin-left: 20px;
        max-width: 400px;
        width: auto;
        padding-right: 10px;
        background: var(--bg-color);
        border: 1px solid var(--divider-color);
        border-radius: 4px;
        color: var(--text-color);
        font-size: 75%;
      }
      
      @media (max-width: 767px) {
        .cover img:hover {
          -webkit-transform: none;
          transform: none;
        }

        ul > li > ul >li:nth-child(2n+1)>.cover:hover >.tooltip{
          display: flex;
          margin-left: 20px;
          margin-right: 20px;
          margin-top: -3rem;
          position: absolute;
          z-index: 1;
          max-width: 400px;
          width: auto;
          padding-right: 10px;
          background: var(--bg-color);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          color: var(--text-color);
          font-size: 75%;
        }

        ul > li > ul >li:nth-child(2n+2)>.cover:hover >.tooltip{
          margin-left: -25%;
          margin-right: 10%;
          display: flex;
          margin-top: -3rem;
          position: absolute;
          z-index: 1;
          max-width: 400px;
          width: auto;
          padding-right: 10px;
          background: var(--bg-color);
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          color: var(--text-color);
          font-size: 75%;
        }
      }
      
      /* Tooltip CSS End */
    </style>
  `

  markup('head').append(css)

  fs.writeFileSync(path.join(basePath, file), markup.html())
}
