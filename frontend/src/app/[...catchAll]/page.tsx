import { redirect } from 'next/navigation';
import { BACKEND_API_URL } from '../../../service.config';

const proccess = async (catchAll: string[]) => {
  try {
    const buildUrl = `https://tiktok.com/${catchAll.join('/')}`;

    const getData = await fetch(
      `${BACKEND_API_URL}/by_url/${encodeURIComponent(
        buildUrl
      )}`
    );

    const res = await getData.json();
    console.log(res);
    return {
      redirectTarget: res.id ? `/post/${res.id}` : '/404',
    };
  } catch (err) {
    return {
      redirectTarget: '/404',
    };
  }
};

export default async function CatchAll({
  params: { catchAll },
}: {
  params: {
    catchAll: string[];
  };
}) {
  const { redirectTarget } = await proccess(catchAll);

  redirect(redirectTarget);
  return <></>;
}
