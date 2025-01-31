import jsdom from 'jsdom';
import { findObjectWithKey } from './objects';
import {
  createAuthor,
  createCarousel,
  createPost,
  createVideo,
  fetchPostByTiktokId,
  fetchSessionByToken,
  findAuthorByTiktokId,
  restorePost,
  updateVideo,
} from './db-helpers';
import xbogus from 'xbogus';
import { z } from 'zod';
import path, { join } from 'path';
import { downloadFileHelper, ensureDirectoryExistence } from './disk-utils';
import { convertToHLS } from './video-processing';
import { parsedVideoData } from './zod';

export const userAgent =
  'Mozilla/5.0 (X11; Linux x86_64; rv:91.0) Gecko/20100101 Firefox/91.1';

export const URL_SANS_BOGUS = {
  FETCH_POST: 'FETCH_POST',
  RELATED_POSTS: 'RELATED_POSTS',
} as const;

export const tiktokFetchOptions = ({
  formattedCookies,
  stringURL,
}: {
  formattedCookies: string;
  stringURL: string;
}) => ({
  headers: {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9,es;q=0.8',
    'cache-control': 'no-cache',
    'User-Agent': userAgent,
    pragma: 'no-cache',
    priority: 'u=1, i',
    'sec-ch-ua': '"Chromium";v="127", "Not)A;Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    cookie: formattedCookies,
    Referer: stringURL,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  },
  body: null,
  method: 'GET',
});

export const parseTikTokData = async (res: Response) => {
  let cookies: string[] = [];
  for (let [key, value] of res.headers.entries()) {
    if (key.toLowerCase() === 'set-cookie') {
      cookies.push(value);
    }
  }

  const textContent = await res.text();

  const dom = new jsdom.JSDOM(textContent);
  const rehydrationData = dom.window.document.querySelector(
    '#__UNIVERSAL_DATA_FOR_REHYDRATION__'
  )?.textContent;
  const jsonParseData = rehydrationData ? JSON.parse(rehydrationData) : null;

  if (!jsonParseData) {
    return new Error('No Data Found');
  }

  const deviceId = findObjectWithKey(jsonParseData, 'wid');
  const odinId = findObjectWithKey(jsonParseData, 'odinId');
  const webIdLastTime = findObjectWithKey(jsonParseData, 'webIdCreatedTime');
  const abTest = findObjectWithKey(jsonParseData, 'abTestVersion');
  const abTestVersions: string[] = abTest ? abTest.versionName.split(',') : [];
  const msToken = res.headers.get('x-ms-token');

  return {
    deviceId,
    odinId,
    webIdLastTime,
    abTestVersions,
    msToken,
    cookies,
    joinedCookies: cookies.join(';'),
  };
};

const BASE_DOMAINS_WHITELIST = [
  'tiktok.com', 'tiktokcdn.com', 'tiktokcdn-eu.com'
];

function throwIfBaseDomainIsNotInWhitelist(url: URL): void {
  for (let i=0; i<BASE_DOMAINS_WHITELIST.length; i+=1) {
    if (url.host.endsWith(BASE_DOMAINS_WHITELIST[i])) {
      return;
    }
  }
  const errMsg = `Refuse to fetch ${url.href}`;
  console.log(errMsg);
  throw new Error(errMsg);
}

export const fetchAndFollowURL = async (url: string) => {
  const controller = new AbortController();
  const decodeURI = decodeURIComponent(url);
  let parsedURL = new URL(url);
  throwIfBaseDomainIsNotInWhitelist(parsedURL);
  setTimeout(() => {
    controller.abort();
  }, 1000 * 5);
  let fetchContent = await fetch(decodeURI, {
    signal: controller.signal,
    headers: {
      'User-Agent': userAgent,
    },
  });
  const fetchURL = fetchContent.url;
  console.log(fetchContent.url);
  if (
    fetchContent.status === 301 ||
    fetchContent.status === 302 ||
    fetchURL !== url
  ) {
    const redirectLocation =
      fetchContent.status === 301 || fetchContent.status === 302
        ? fetchContent.headers.get('location')
        : fetchURL;
    if (redirectLocation) {
      console.log('Redirected');
      parsedURL = new URL(redirectLocation);
      fetchContent = await fetch(redirectLocation, {
        headers: {
          'User-Agent': userAgent,
        },
      });
    }
  }

  return {
    response: fetchContent,
    url: parsedURL,
  };
};

export const pullVideoData = async (
  jsonContent: any,
  mode: (typeof URL_SANS_BOGUS)[keyof typeof URL_SANS_BOGUS],
  watchedIds?: string[]
) => {
  const itemList = URL_SANS_BOGUS.RELATED_POSTS
    ? findObjectWithKey(jsonContent, 'itemList')
    : null;
  const item =
    mode === URL_SANS_BOGUS.FETCH_POST
      ? findObjectWithKey(jsonContent, 'itemStruct')
      : itemList && 'map' in itemList
      ? itemList.find((item: { id: string }) => !watchedIds?.includes(item.id))
      : null;

  if (!item) {
    return new Error('No itemStruct found');
  }

  const id = findObjectWithKey(item, 'id');
  const imageDetail = findObjectWithKey(item, 'imagePost');
  const videoDetail = findObjectWithKey(item, 'video');
  const authorDetails = findObjectWithKey(item, 'author');
  const musicDetails = findObjectWithKey(item, 'music');
  const imageList = imageDetail
    ? findObjectWithKey(imageDetail, 'images')
        ?.map((list: { imageURL: { urlList: string[] } }) =>
          list?.imageURL?.urlList ? list?.imageURL?.urlList[0] : null
        )
        .filter((image: string | null) => image !== null)
    : null;
  const postDescription = `${
    imageDetail?.title ? `${imageDetail.title} |` : ''
  } ${findObjectWithKey(item, 'desc')}`;
  const videoURL = videoDetail ? videoDetail.playAddr : null;

  const dataObject = {
    id,
    description: postDescription,
    image: imageDetail
      ? {
          list: imageList,
        }
      : null,
    video: videoDetail
      ? {
          url: videoURL,
          cover: videoDetail.cover,
        }
      : null,
    author: authorDetails
      ? {
          id: authorDetails.id,
          name: authorDetails.nickname,
          image: authorDetails.avatarLarger,
          handle: authorDetails.uniqueId,
        }
      : null,
    music: musicDetails
      ? {
          url: musicDetails.playUrl,
        }
      : null,
  };

  const parsedData = parsedVideoData.safeParse(dataObject);

  if (parsedData.success) {
    return parsedData.data;
  } else {
    console.log(dataObject);
    return new Error('Data hold unexpected format');
  }
};

export const fetchPostByUrlAndMode = async (
  url: string,
  mode: (typeof URL_SANS_BOGUS)[keyof typeof URL_SANS_BOGUS],
  sessionToken?: string
) => {
  try {
    const { response, url: finalURL } = await fetchAndFollowURL(url);

    const postId = finalURL.pathname.split('/').at(-1);
    if (!postId) {
      return new Error('Video ID not found');
    }
    const findPost = await fetchPostByTiktokId(postId);

    if (findPost) {
      return findPost;
    }

    const parseData = await parseTikTokData(response);

    if (!parseData || parseData instanceof Error) {
      return new Error('Something went wrong');
    }

    const {
      deviceId,
      odinId,
      webIdLastTime,
      abTestVersions,
      msToken,
      joinedCookies,
    } = parseData;

    const URLSansBogus =
      mode === URL_SANS_BOGUS.FETCH_POST
        ? `https://www.tiktok.com/api/item/detail/?WebIdLastTime=${webIdLastTime}&aid=1988&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla&browser_online=true&browser_platform=MacIntel&browser_version=${encodeURIComponent(
            userAgent
          )}&channel=tiktok_web&${abTestVersions.map(
            (version) => `clientABVersions${version}&`
          )}cookie_enabled=true&coverFormat=2&data_collection_enabled=true&device_id=${deviceId}&device_platform=web_pc&focus_state=true&from_page=user&history_len=1&is_fullscreen=false&is_page_visible=true&itemId=${postId}&language=en&odinId=${odinId}&os=mac&priority_region=ES&referer=&region=ES&screen_height=1117&screen_width=1728&tz_name=Europe%2FMadrid&user_is_login=true&verifyFp=verify_lws1fk3n_P0R9e85b_CSlT_4mNA_BBoR_9av0jRDDSXI0&webcast_language=en&msToken=${msToken}`
        : mode === URL_SANS_BOGUS.RELATED_POSTS
        ? `https://www.tiktok.com/api/related/item_list/?WebIdLastTime=${webIdLastTime}&aid=1988&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla&browser_online=true&browser_platform=MacIntel&browser_version=${encodeURIComponent(
            userAgent
          )}&channel=tiktok_web&${abTestVersions.map(
            (version) => `clientABVersions${version}&`
          )}cookie_enabled=true&count=16&coverFormat=2&cursor=0&data_collection_enabled=true&device_id=${deviceId}&device_platform=web_pc&focus_state=true&from_page=video&history_len=2&isNonPersonalized=false&is_fullscreen=false&is_page_visible=true&itemID=${postId}&language=en&odinId=${odinId}&os=mac&priority_region=ES&referer=&region=ES&screen_height=1117&screen_width=1728&tz_name=Europe%2FMadrid&user_is_login=true&verifyFp=verify_lws1fk3n_P0R9e85b_CSlT_4mNA_BBoR_9av0jRDDSXI0&webcast_language=en`
        : '';
    const xbogus_parameter = xbogus(URLSansBogus, userAgent);

    const fetchContent = await fetch(
      `${URLSansBogus}&X-Bogus=${xbogus_parameter}`,
      {
        ...tiktokFetchOptions({
          formattedCookies: joinedCookies,
          stringURL: URLSansBogus,
        }),
      }
    );

    const jsonContent = await fetchContent.json();
    let watchedIds;
    if (sessionToken) {
      const userSession = await fetchSessionByToken(sessionToken);
      if (userSession) {
        watchedIds = userSession.watched.split(',');
      }
    }

    const videoData = await pullVideoData(jsonContent, mode, watchedIds);

    if (videoData instanceof Error) {
      return videoData;
    }

    const { author, description, id: postID, image, music, video } = videoData;

    if (!author) {
      return new Error('Author not found');
    }
    let workingAuthor = await findAuthorByTiktokId(author.id);

    if (!workingAuthor) {
      const authorDirPath = path.join(process.cwd(), 'public', 'authors');
      const authorImagePath = path.join(authorDirPath, `${author.id}.jpg`);
      if (author.image) {
        await downloadFileHelper(author.image, authorDirPath, authorImagePath);
      }

      workingAuthor = await createAuthor(
        author.id,
        author.name,
        `/authors/${author.id}.jpg`,
        author.handle
      );
    }

    if (image) {
      const musicDirPath = path.join(process.cwd(), 'public', 'audio');
      const musicFilePath = path.join(musicDirPath, `${postID}.mp4`);
      if (music?.url) {
        downloadFileHelper(music.url, musicDirPath, musicFilePath);
      }

      const images = await Promise.all(
        image.list.map(async (imageURL, index) => {
          const dirPath = path.join(process.cwd(), 'public', 'images', postID);
          const filePath = path.join(dirPath, `${index}.jpg`);

          if (ensureDirectoryExistence(filePath)) {
            await downloadFileHelper(imageURL, dirPath, filePath);
            return `/images/${postID}/${index}.jpg`;
          } else {
            return null;
          }
        })
      );

      const post = await createPost({
        authorId: workingAuthor.id,
        type: 'photo',
        tiktokId: postID,
        postDesc: description,
        originalURL: finalURL.toString(),
      });

      await createCarousel({
        audio: music?.url ? `/audio/${postID}.mp4` : '',
        images: images.filter((image) => image !== null).toString(),
        postId: post.id,
      });
    } else if (video) {
      const videoDirPath = path.join(process.cwd(), 'public', 'videos');
      const videoFilePath = path.join(videoDirPath, `${postID}.mp4`);
      if (video.url) {
        await downloadFileHelper(
          video.url,
          videoDirPath,
          videoFilePath,
          joinedCookies
        );
      }

      const thumbnailDirPath = path.join(process.cwd(), 'public', 'thumbnails');
      const thumbnailFilePath = path.join(thumbnailDirPath, `${postID}.jpg`);
      if (video.cover) {
        downloadFileHelper(video.cover, videoDirPath, thumbnailFilePath);
      }

      const post = await createPost({
        authorId: workingAuthor.id,
        type: 'video',
        tiktokId: postID,
        postDesc: description,
        originalURL: finalURL.toString(),
      });

      const toHLS = {
        hlsPath: path.join(process.cwd(), 'public', 'hls', post.id.toString()),
        hlsOutput: `/hls/${post.id}/output.m3u8`,
        videoPath: videoFilePath,
      };

      convertToHLS(toHLS.videoPath, toHLS.hlsPath, async (err, output) => {
        if (err) {
          console.log(err);
        } else if (output) {
          console.log('Updating');
          await updateVideo({
            hlsVideo: toHLS.hlsOutput,
            postId: post.id,
          });
        }
      });

      await createVideo({
        mp4video: `/videos/${postID}.mp4`,
        thumbnail: `/thumbnails/${postID}.jpg`,
        postId: post.id,
      });
    }
    return await fetchPostByTiktokId(postID);
  } catch (error) {
    return error instanceof Error ? error : new Error('Something went wrong');
  }
};

export const downloadPostByUrl = async (url: string, originalID: number) => {
  try {
    const { response, url: finalURL } = await fetchAndFollowURL(url);

    const postId = finalURL.pathname.split('/').at(-1);
    if (!postId) {
      return new Error('Video ID not found');
    }
    const findPost = await fetchPostByTiktokId(postId);

    if (findPost) {
      return findPost;
    }

    const parseData = await parseTikTokData(response);

    if (!parseData || parseData instanceof Error) {
      return new Error('Something went wrong');
    }

    const {
      deviceId,
      odinId,
      webIdLastTime,
      abTestVersions,
      msToken,
      joinedCookies,
    } = parseData;

    const URLSansBogus = `https://www.tiktok.com/api/item/detail/?WebIdLastTime=${webIdLastTime}&aid=1988&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla&browser_online=true&browser_platform=MacIntel&browser_version=${encodeURIComponent(
      userAgent
    )}&channel=tiktok_web&${abTestVersions.map(
      (version) => `clientABVersions${version}&`
    )}cookie_enabled=true&coverFormat=2&data_collection_enabled=true&device_id=${deviceId}&device_platform=web_pc&focus_state=true&from_page=user&history_len=1&is_fullscreen=false&is_page_visible=true&itemId=${postId}&language=en&odinId=${odinId}&os=mac&priority_region=ES&referer=&region=ES&screen_height=1117&screen_width=1728&tz_name=Europe%2FMadrid&user_is_login=true&verifyFp=verify_lws1fk3n_P0R9e85b_CSlT_4mNA_BBoR_9av0jRDDSXI0&webcast_language=en&msToken=${msToken}`;
    const xbogus_parameter = xbogus(URLSansBogus, userAgent);

    const fetchContent = await fetch(
      `${URLSansBogus}&X-Bogus=${xbogus_parameter}`,
      {
        ...tiktokFetchOptions({
          formattedCookies: joinedCookies,
          stringURL: URLSansBogus,
        }),
      }
    );

    const jsonContent = await fetchContent.json();

    const videoData = await pullVideoData(
      jsonContent,
      URL_SANS_BOGUS.FETCH_POST
    );

    if (videoData instanceof Error) {
      return videoData;
    }

    const { id: postID, image, music, video } = videoData;

    if (image) {
      const musicDirPath = path.join(process.cwd(), 'public', 'audio');
      const musicFilePath = path.join(musicDirPath, `${postID}.mp4`);
      if (music?.url) {
        downloadFileHelper(music.url, musicDirPath, musicFilePath);
      }

      await Promise.all(
        image.list.map(async (imageURL, index) => {
          const dirPath = path.join(process.cwd(), 'public', 'images', postID);
          const filePath = path.join(dirPath, `${index}.jpg`);

          if (ensureDirectoryExistence(filePath)) {
            await downloadFileHelper(imageURL, dirPath, filePath);
            return `/images/${postID}/${index}.jpg`;
          } else {
            return null;
          }
        })
      );
    } else if (video) {
      const videoDirPath = path.join(process.cwd(), 'public', 'videos');
      const videoFilePath = path.join(videoDirPath, `${postID}.mp4`);
      if (video.url) {
        await downloadFileHelper(video.url, videoDirPath, videoFilePath);
      }

      const thumbnailDirPath = path.join(process.cwd(), 'public', 'thumbnails');
      const thumbnailFilePath = path.join(thumbnailDirPath, `${postID}.jpg`);
      if (video.cover) {
        downloadFileHelper(video.cover, videoDirPath, thumbnailFilePath);
      }

      const toHLS = {
        hlsPath: path.join(process.cwd(), 'public', 'hls', postID),
        hlsOutput: `/hls/${postID}/output.m3u8`,
        videoPath: videoFilePath,
      };

      convertToHLS(toHLS.videoPath, toHLS.hlsPath, async (err, output) => {});
    }
    await restorePost(originalID);
    return await fetchPostByTiktokId(postID);
  } catch (error) {
    console.error(error)
    return error instanceof Error ? error : new Error('Something went wrong');
  }
};
