'use strict';

function sourceError(kind, message, extra) {
  const error = new Error(message);
  error.kind = kind;
  if (extra) {
    for (const field in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, field)) {
        error[field] = extra[field];
      }
    }
  }
  return error;
}

const BASE_URL = 'https://libgen.li';

async function fetchHtml(url) {
  const response = await kikuyomi.http.fetch({ url: url, method: 'GET' });
  if (response.status === 404) throw sourceError('NotFound', 'Page not found');
  if (response.status === 429) throw sourceError('RateLimited', 'Rate limited by Libgen');
  if (response.status >= 500) throw sourceError('Network', 'Libgen server error');
  if (response.status !== 200) throw sourceError('Parse', 'Unexpected HTTP status: ' + response.status);
  
  // Detect Libgen database connection errors inside 200 OK responses
  const bodyText = typeof response.body === 'string' ? response.body : '';
  if (bodyText.includes('max_user_connections') || bodyText.includes('could not connect to database')) {
    throw sourceError('RateLimited', 'Libgen database is overloaded. Try again in a few moments.');
  }

  return await kikuyomi.html.parse(response.body, response.url);
}

// Keep the last 100 books in memory
const bookCache = new Map();

function cacheBook(book) {
  bookCache.set(book.key, book);
  // Prevent memory leaks by bounding the cache size
  if (bookCache.size > 100) {
    const firstKey = bookCache.keys().next().value;
    bookCache.delete(firstKey);
  }
}

const libgenSource = {
  getPopular: async function (page) {
    return this.search({ text: 'novel' }, page);
  },

  search: async function (query, page) {
    const searchTerm = query.text ? encodeURIComponent(query.text) : 'novel';
    const url = `${BASE_URL}/index.php?req=${searchTerm}&page=${page}&res=100&ext=epub`;
    
    let doc;
    try {
      doc = await fetchHtml(url);
    } catch (e) {
      if (e.kind === 'NotFound') return { items: [], hasNextPage: false };
      throw e;
    }

    const items = [];
    const rows = doc.select('table tr');
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const cols = row.select('td');
      
      // A standard Libgen data row has 8-10 columns
      if (cols.length < 8) continue;

      // Extract the MD5 from the raw HTML of the row
      const rowHtml = row.html();
      const md5Match = rowHtml.match(/md5=([A-Fa-f0-9]{32})/i);
      if (!md5Match) continue;

      const key = md5Match[1].toLowerCase();

      // Extract the cover image directly from the row
      let coverUrl = undefined;
      const img = row.selectFirst('img');
      if (img) {
        coverUrl = new URL(img.absUrl('src'), BASE_URL).href;
      }
      
      // Column 2 is typically the Author
      const authorText = cols[1].text().trim();
      const authors = authorText ? authorText.split(',').map(a => a.trim()).filter(a => a) : [];

      // Column 1 is typically the Title
      // Extract the Title smartly without merging all the text in the cell
      let title = '';
      
      // First, check if the title is inside a <b> tag (like "Mr.Avenger")
      const bTag = cols[0].selectFirst('b');
      if (bTag) {
          title = bTag.text().trim();
      } else {
          // Fallback: check if it's inside the main <a> tag (like "Knowing God")
          const aTag = cols[0].selectFirst('a');
          if (aTag) {
              title = aTag.text().trim();
          } else {
              // Final fallback if neither exists
              title = cols[0].text().trim();
          }
      }

      // Clean up any lingering bracketed text if needed
      title = title.replace(/\[.*?\]/g, '').trim();
      
      // Fallback in case cols[0] was just the image and yielded empty text
      if (!title && cols.length > 2) {
         title = cols[2].text().trim().replace(/\[.*?\]/g, '').trim(); 
      }

      
      const item = {
        key: key,
        title: title || 'Unknown Title',
        authors: authors,
        coverUrl: coverUrl
      };
      
      cacheBook(item);
      items.push(item);
    }


    return {
      items: items,
      hasNextPage: items.length === 100
    };
  },

  getBookDetails: async function (bookKey) {
    // 1. Check the cache first (saves a network request!)
    if (bookCache.has(bookKey)) {
      const cached = bookCache.get(bookKey);
      return {
        key: bookKey,
        title: cached.title,
        authors: cached.authors || [],
        narrators: [],
        genres: [],
        coverUrl: cached.coverUrl,
        status: 'complete',
        webUrl: `${BASE_URL}/ads.php?md5=${bookKey}`
      };
    }

    // 2. Fallback if cache is empty
    const url = `${BASE_URL}/ads.php?md5=${bookKey}`;
    const doc = await fetchHtml(url);

    let title = 'Libgen Book';
    let authors = [];
    let coverUrl = undefined;

    // A. Extract Cover Image
    const coverImg = doc.selectFirst('table tr td img');
    if (coverImg) {
        coverUrl = new URL(coverImg.absUrl('src'), BASE_URL).href;
    }

    // B. Find the table cell containing the metadata
    const cells = doc.select('td');
    let infoHtml = '';
    
    for (let i = 0; i < cells.length; i++) {
        const cellHtml = cells[i].html();
        if (cellHtml && cellHtml.includes('Title:')) {
            infoHtml = cellHtml;
            break;
        }
    }

    // C. Extract Title and Author(s) using HTML boundaries (<br>)
    if (infoHtml) {
        // Matches "Title: [Capture Group] <br>"
        // .*? is non-greedy, so it stops at the very first <br> it sees
        const titleMatch = infoHtml.match(/Title:\s*(.*?)(?:<br>|$)/i);
        if (titleMatch && titleMatch[1]) {
            // Strip out any accidental nested HTML tags inside the title just in case
            title = titleMatch[1].replace(/<[^>]*>?/gm, '').trim();
        }

        // Matches "Author(s): [Capture Group] <br>"
        const authorMatch = infoHtml.match(/Author\(s\):\s*(.*?)(?:<br>|$)/i);
        if (authorMatch && authorMatch[1]) {
            const authorText = authorMatch[1].replace(/<[^>]*>?/gm, '').trim();
            authors = authorText ? authorText.split(',').map(a => a.trim()).filter(a => a) : [];
        }
    }

    return {
      key: bookKey,
      title: title,
      authors: authors,
      narrators: [],
      genres: [], 
      coverUrl: coverUrl,
      status: 'complete',
      webUrl: url
    };
  },

  resolveBook: async function (bookKey) {
    const adsUrl = `${BASE_URL}/ads.php?md5=${bookKey}`;
    const doc = await fetchHtml(adsUrl);

    let downloadLink = null;
    const links = doc.select('a');
    for (let i = 0; i < links.length; i++) {
        const href = links[i].attr('href');
        const text = links[i].text().trim().toUpperCase();
        
        if (href && (href.includes('key=') || text === 'GET' || text.includes('GET'))) {
            downloadLink = new URL(href, BASE_URL).href;
            break;
        }
    }

    if (!downloadLink) {
         throw sourceError('NotFound', 'Could not find tokenized download link on ads page');
    }

    // Fetch the tokenized link and follow redirects to the CDN
    const response = await kikuyomi.http.fetch({ url: downloadLink, method: 'GET' });

    // SAFETY CHECK: Verify final host destination after redirect
    const finalHost = new URL(response.url).hostname;
    const trustedDomains = ['libgen.li', 'booksdl.lc'];
    const isTrusted = trustedDomains.some(domain => finalHost === domain || finalHost.endsWith('.' + domain));

    if (!isTrusted) {
        throw sourceError('Network', `Blocked suspicious redirect to untrusted domain: ${finalHost}`);
    }

    return {
      request: { url: response.url || downloadLink },
      format: 'epub'
    };
  }

};

module.exports = { sources: { libgen_li: libgenSource } };