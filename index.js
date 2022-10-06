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
      isbn: $(this).children('p:has(span:contains("bookcover:")):not(:contains("!"))').text().replace('bookcover: ', '').trim(),
      title: $(this).find('p:not(:has(span)):has(a)').first().html(),
      comment: $(this).find('ul > li > ul > li > p').html(),
      cover: '',
      alternative: $(this).children('p:has(span:contains("bookcover:")):contains("!")').text().replace('bookcover: !', '').trim(),
    }
  }).toArray();
}

async function addExistentCovers(data) {
  console.log("   step: check existent book covers")

  return data.map(function(entry) {
    let uuid = entry.isbn || Buffer.from(entry.alternative).toString('hex')

    let fileName = `covers/${uuid}.jpg`
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
  const downloadBestCover = (uuid, cover) => {
    if (cover.includes('default.jpg')) {
      return cover
    } else {
      return new Promise((resolve) => {
        download.image({ url: cover, dest: path.join(basePath, `covers/${uuid}.jpg`) })
          .then(({ _filename }) => {
            resolve(`covers/${uuid}.jpg`)
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
    } else if (entry.alternative && !entry.isbn && !entry.cover) {
      let uuid = Buffer.from(entry.alternative).toString('hex')

      entry.cover = await downloadBestCover(uuid, entry.alternative)
                      .then(cover => transformCover(cover))
    } else if (!entry.isbn && !entry.alternative && !entry.cover) {
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
		/* Cover and Tooltip CSS including media-queries for mobile screens — 0.26 */

			* {
				box-sizing: border-box;
			}
			body {
				margin: 0;
				padding: 0;
			}

			.cover {
				padding: 0;
				margin: 0;
				width: fit-content;
				display: inline-flex;
				margin-right: 10px;
				cursor: pointer;
				position: relative;
			}

			.cover img {
				width: 100px;
				height: 157px;
				margin: 0;
				padding: 0;
				border: 1px solid var(--divider-color);
				border-radius: 5px;
				filter: drop-shadow(0 2px 8px rgba(0, 0, 0, .11));
				-webkit-filter: drop-shadow(0 2px 8px rgba(0, 0, 0, .11));
				-webkit-transition: all .2s ease-in-out;
				transition: all .2s ease-in-out;
				}

			 .cover img:hover {
				-webkit-transform: scale(1.07);
				transform: scale(1.07);
				}

				ul > li {
					text-align: left;
				}

				/* tooltips  */
				.cover>.tooltip {
					display: none;
					position: absolute;
					color: var(--text-color);
					font-size: 70%;
					min-width: 400px;
					float: right;
					top: -45px;
					left: 20px;
					z-index: 1;
				}
				
				.cover:hover>.tooltip { 
					display: flex;
				}


				/* Tooltip Hover CSS Begin */

				.cover>.tooltip>ul {
					margin: 0px;
					padding: 15px;
					position: relative;
					background: var(--bg-color);
					border: 1px solid var(--divider-color);
					border-radius: 4px;
				}
				.cover>.tooltip>ul>li {
					line-height: 20px;
					text-align: left;
					margin: 0 0 10px 0;
				}

				.cover>.tooltip>ul>li:last-child {
					margin: 0;
				}

				.cover>.tooltip>ul>li:first-child a{
					font-size: 19px;
					font-weight: bold;
				}

				
				@media screen and (max-width: 1200px)
				 {	
					.cover>.tooltip {
						min-width: 300px;
					}	
				 }
				

				 @media screen and (max-width: 992px)
				 {	
					
					ul>li>ul ul {
						padding: 0 20px;
					}
	
				 
					.cover:hover>.tooltip{
						min-width: 225px;
					}
					
					.main article ul ul {
						padding: 0 30px;
						position: relative
					}
					.cover:hover>.tooltip {
						left: unset;
						min-width: unset;
						width: auto;
						padding-left: 10px;
						top: unset;
						margin: -40px 0 0 0;
					}
					
					.cover>.tooltip>ul>li:first-child a {
						font-size: 18px;
						width: 100%;
						line-height: 1.2;
						display: inline-block;
					}
					.cover>.tooltip>ul>li {
						font-size: 16px;
						line-height: normal;
					}
					
					ul>li>ul>li .cover {
						margin:0;
						position: inherit;
					}
					
					.main article ul {
						padding: 0 10px;
						margin-left: 0;
						margin-right: 0;
					}

					ul>li>ul>li li {
						margin: 0;
						padding: 5px;
					}

					footer {
						justify-content: center;
						margin: 10px 0;
						padding: 40px 0;
						width: 100%;
					}
				}

				@media screen and (max-width: 767px)
				{
					.cover>.tooltip>ul>li a {
						font-size: 16px;
					}

					.main article ul ul {
						padding: 0 50px;
					}

					.main article > h1 {
						font-size: 1.7rem;
						line-height: normal;
						padding: 0 10px;
					}

					ul>li>ul>li .cover .tooltip li {
						padding: 0;
					}
					
					.pinned {
							font-size: 18px;
						line-height: 1.4;
					}

				}
				
				@media screen and (max-width: 480px) {
					
					.main article ul ul {
						padding: 0 20px;
					}
					
					.cover:hover>.tooltip {
						left: 0;
						min-width: unset;
						width: 100%;
						padding: 0 20px;
						top: unset;
						margin: -40px 0 0 0;
						right: 0;
						display: block;
					}
					
				}
	
			/* Tooltip CSS End */

		</style>
  `

  markup('head').append(css)

  fs.writeFileSync(path.join(basePath, file), markup.html())
}
