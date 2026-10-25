export default function SupplierProductsPage() {
  return (
    <s-page heading="منتجات الموردين">
      <s-section heading="مسار المراجعة قبل النشر">
        <s-paragraph>
          هذه الصفحة محجوزة للمرحلة التالية: استقبال منتجات الموردين من جلسة
          واتساب التجريبية، مراجعة الصور والوصف والسعر، ثم إنشاء مسودة في
          Shopify وجدولة نشرها بعد موافقتك.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="حماية المتجر">
        <s-unordered-list>
          <s-list-item>لن يُنشر أي منتج تلقائيًا في هذه النسخة.</s-list-item>
          <s-list-item>الإنشاء الافتراضي سيكون كمسودة للمراجعة.</s-list-item>
          <s-list-item>الجدولة والنشر سيحتاجان موافقة صريحة.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}
